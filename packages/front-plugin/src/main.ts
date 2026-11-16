import Front from "@frontapp/plugin-sdk";
import type { CaptureResult } from "@overturn-ai/shared";
import {
  type AppSettings,
  type ConversationSnapshot,
  createDraftDetector,
  type DraftState,
  decideOnSend,
  inScope,
  quickReasons,
  settingsFrom,
  statusLine,
} from "./capture";

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Record<string, string> = {},
  text?: string,
): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  if (text !== undefined) e.textContent = text;
  return e;
}

export interface FrontMessageLike {
  id: string;
  body?: string;
  content?: { body: string; type?: "html" | "text" };
  status?: "inbound" | "outbound" | string;
  from?: { name?: string; handle?: string };
  type?: string;
  date?: Date;
}

export interface FrontPluginContextLike {
  type: string;
  conversation?: {
    id: string;
    subject?: string;
    recipient?: { name?: string; handle?: string };
    tags?: ReadonlyArray<{ id: string; name: string }>;
    customFieldAttributes?: ReadonlyArray<{ id: string; name: string; value: unknown }>;
    draftId?: string;
  };
  draft?: {
    id: string;
    content?: { body: string; type: "html" | "text" };
    subject?: string;
  };
  teammate?: {
    id: string;
    name?: string;
    email?: string;
  };
  listMessages?: () => Promise<{
    results: ReadonlyArray<FrontMessageLike>;
  }>;
  fetchDraft?: (draftId: string) => Promise<
    | {
        id: string;
        content?: { body: string; type: "html" | "text" };
        subject?: string;
      }
    | undefined
  >;
}

export interface FrontPluginClient {
  contextUpdates: {
    subscribe: (observer: (ctx: unknown) => void) => { unsubscribe: () => void };
  };
}

export interface FrontPluginInitOptions {
  front?: FrontPluginClient;
  root?: HTMLElement;
  fetchFn?: typeof fetch;
  customSettings?: Record<string, unknown>;
}

/** Parses search params or dataset config into settings map. */
export function readInitialSettings(customSettings?: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  if (typeof window !== "undefined" && window.location?.search) {
    const params = new URLSearchParams(window.location.search);
    for (const [k, v] of params.entries()) {
      result[k] = v;
    }
  }
  if (customSettings) {
    Object.assign(result, customSettings);
  }
  return result;
}

/** Initializes the Front capture plugin inside the sidebar iframe. */
export function initFrontPlugin(options: FrontPluginInitOptions = {}): {
  destroy: () => void;
  getDraft: () => DraftState | null;
  triggerSend: (sentText: string, isInternal?: boolean) => Promise<boolean>;
} {
  const frontClient = (options.front ?? Front) as FrontPluginClient;
  const root = options.root ?? (typeof document !== "undefined" ? document.getElementById("app") : null);
  const fetchClient = options.fetchFn ?? (typeof fetch !== "undefined" ? fetch.bind(window) : undefined);

  const initialConfig = readInitialSettings(options.customSettings);
  const settings: AppSettings = settingsFrom(initialConfig);
  const detector = createDraftDetector({ minDraftChars: settings.minDraftChars });

  let reasonCode: string | null = null;
  let lastResult: { kind: string; changed: boolean; dedup: boolean } | null = null;
  let currentContext: FrontPluginContextLike | null = null;
  let currentDraftText = "";
  let draftFields: Record<string, unknown> = {};

  const status = el("div", { class: "status" }, "Waiting for a draft");
  const quick = el("div", {
    class: "quick",
    role: "radiogroup",
    "aria-label": "Why did you change it?",
  });
  const chips: HTMLButtonElement[] = [];

  for (const q of quickReasons(settings)) {
    const b = el("button", { type: "button", class: "chip", "data-code": q.code }, q.label);
    b.addEventListener("click", () => {
      reasonCode = reasonCode === q.code ? null : q.code;
      for (const c of chips) c.classList.toggle("on", c.dataset.code === reasonCode);
    });
    chips.push(b);
    quick.appendChild(b);
  }

  const reasonInput = el("textarea", {
    class: "reason",
    rows: "2",
    placeholder: "Anything else? Optional.",
  });
  const mark = el("button", { type: "button", class: "link" }, "Use the current text as the draft");
  const note = el("div", { class: "note" }, "");

  const render = (): void => {
    status.textContent = statusLine(detector.current(), lastResult);
  };

  mark.addEventListener("click", () => {
    if (!currentDraftText.trim()) return;
    detector.set({ text: currentDraftText, origin: "manual", at: Date.now() });
    lastResult = null;
    render();
  });

  if (root) {
    root.append(status, quick, reasonInput, mark, note);
  }

  const readFields = (ctx: FrontPluginContextLike): Record<string, unknown> => {
    if (settings.decisionFields.length === 0 || !ctx.conversation?.customFieldAttributes) return {};
    const attrs = ctx.conversation.customFieldAttributes;
    const result: Record<string, unknown> = {};
    for (const f of settings.decisionFields) {
      const match = attrs.find((a) => a.id === f.id || a.name === f.label || a.name === f.id);
      result[f.label] = match?.value ?? null;
    }
    return result;
  };

  const handleContext = async (rawCtx: unknown): Promise<void> => {
    const ctx = rawCtx as FrontPluginContextLike;
    currentContext = ctx;
    const conversation = ctx?.conversation;
    if (!conversation) {
      status.textContent = "Waiting for a conversation";
      return;
    }

    // Scope check: if scopeTag is set, conversations without it are ignored.
    if (settings.scopeTag) {
      const tagNames = (conversation.tags ?? []).map((t) => t.name);
      if (!inScope(tagNames, settings)) {
        status.textContent = `Not watching: no "${settings.scopeTag}" tag`;
        quick.style.display = "none";
        reasonInput.style.display = "none";
        mark.style.display = "none";
        return;
      }
      quick.style.display = "";
      reasonInput.style.display = "";
      mark.style.display = "";
    }

    draftFields = readFields(ctx);

    // Look for SDK-recorded run if apiKey is configured and not yet set
    if (settings.apiKey && fetchClient && !detector.current()) {
      try {
        const url = `${settings.baseUrl}/v1/runs?externalId=${encodeURIComponent(`fr:${conversation.id}`)}&agent=${encodeURIComponent(settings.agent)}&limit=1`;
        const res = await fetchClient(url, {
          headers: { Authorization: `Bearer ${settings.apiKey}` },
        });
        if (res.ok) {
          const data = (await res.json()) as {
            items?: Array<{ id: string; output: unknown; agent: string }>;
          };
          const run = data.items?.[0];
          if (run && typeof run.output === "string" && run.output.trim()) {
            detector.set({ text: run.output, origin: "recorded", runId: run.id, at: Date.now() });
          }
        }
      } catch {
        // no recorded draft found; composer is watched instead
      }
    }

    // Extract draft body from composer or conversation draftId
    let draftBody = "";
    if (ctx.type === "messageComposer" && ctx.draft?.content?.body) {
      draftBody = ctx.draft.content.body;
    } else if (conversation.draftId && ctx.fetchDraft) {
      try {
        const fetched = await ctx.fetchDraft(conversation.draftId);
        draftBody = fetched?.content?.body ?? "";
      } catch {
        draftBody = "";
      }
    }

    if (draftBody) {
      currentDraftText = draftBody;
      detector.onComposer(draftBody);
    }

    render();
  };

  const subscription = frontClient.contextUpdates.subscribe((ctx: unknown) => {
    void handleContext(ctx);
  });

  const triggerSend = async (sentText: string, isInternal = false): Promise<boolean> => {
    const draft = detector.current();
    if (!draft || !currentContext?.conversation) return true;

    let messages: Array<{
      id?: string;
      body: string;
      type?: string;
      authorName?: string | null;
      authorEmail?: string | null;
      isAgent?: boolean;
      createdAt?: string | null;
    }> = [];

    if (currentContext.listMessages) {
      try {
        const list = await currentContext.listMessages();
        messages = list.results.map((m) => ({
          id: m.id,
          body: m.content?.body ?? m.body ?? "",
          type: m.status === "inbound" ? "inbound" : "outbound",
          authorName: m.from?.name ?? null,
          authorEmail: m.from?.handle ?? null,
          isAgent: m.status !== "inbound",
          createdAt: m.date ? m.date.toISOString() : null,
        }));
      } catch {
        messages = [];
      }
    }

    const snapshot: ConversationSnapshot = {
      id: currentContext.conversation.id,
      subject: currentContext.conversation.subject ?? null,
      recipientEmail: currentContext.conversation.recipient?.handle ?? null,
      recipientName: currentContext.conversation.recipient?.name ?? null,
      messages,
      fields: readFields(currentContext),
      url: `https://app.frontapp.com/open/${currentContext.conversation.id}`,
    };

    const decision = decideOnSend({
      conversation: snapshot,
      draft,
      draftFields,
      send: {
        text: sentText,
        type: isInternal ? "comment" : "outbound",
        fields: snapshot.fields,
      },
      reasonCode,
      reason: reasonInput.value,
      actor: currentContext.teammate?.email ?? currentContext.teammate?.name ?? null,
      settings,
      now: Date.now(),
    });

    if (decision.action === "skip") return true;

    if (decision.action === "need-reason") {
      chips[0]?.focus();
      const msg = `Overturn: pick why you changed the ${decision.changedFields.length ? decision.changedFields.join(", ") : "reply"} in the Overturn panel (one click).`;
      note.textContent = msg;
      // Blocking changed reply when require_reason is on
      throw new Error(msg);
    }

    if (fetchClient) {
      try {
        const res = await fetchClient(`${settings.baseUrl}/v1/capture`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            ...(settings.apiKey ? { Authorization: `Bearer ${settings.apiKey}` } : {}),
          },
          body: JSON.stringify(decision.body),
        });
        if (res.ok) {
          const r = (await res.json()) as CaptureResult;
          lastResult = { kind: r.kind, changed: r.changed, dedup: r.deduplicated };
          note.textContent = r.changed && r.case ? `Case: ${r.case.title}` : "";
          reasonInput.value = "";
          reasonCode = null;
          for (const c of chips) c.classList.remove("on");
          detector.set(null);
          render();
        } else {
          // Log failure and get out of the way; never block send
          console.error("Overturn capture failed with HTTP status", res.status);
          note.textContent = `Overturn could not save this correction (${res.status}).`;
        }
      } catch (err) {
        // Never block the send on network/capture failure
        console.error("Overturn capture network error:", err);
        note.textContent = "Overturn could not save this correction (network error).";
      }
    }

    return true;
  };

  return {
    destroy: () => subscription.unsubscribe(),
    getDraft: () => detector.current(),
    triggerSend,
  };
}

if (typeof window !== "undefined") {
  initFrontPlugin();
}
