import type { CaptureCreate } from "@overturn-ai/shared";
import { describe, expect, it, vi } from "vitest";

// Mock @frontapp/plugin-sdk to avoid real iframe handshake in node test environment
vi.mock("@frontapp/plugin-sdk", () => {
  return {
    default: {
      contextUpdates: {
        subscribe: () => ({ unsubscribe: () => {} }),
      },
    },
  };
});

import type { FrontPluginContextLike } from "./main";
import { initFrontPlugin } from "./main";

describe("Front SDK Integration (Mocked)", () => {
  const longDraft =
    "Hi Alice,\n\nWe have reviewed your claim and confirmed coverage under policy HO-3. An adjuster will reach out within 5 business days.";

  function createMockFront() {
    let subscriber: ((ctx: FrontPluginContextLike) => void) | null = null;
    return {
      contextUpdates: {
        subscribe: (cb: (ctx: unknown) => void) => {
          subscriber = cb as (ctx: FrontPluginContextLike) => void;
          return {
            unsubscribe: () => {
              subscriber = null;
            },
          };
        },
      },
      emit: (ctx: FrontPluginContextLike) => {
        if (subscriber) subscriber(ctx);
      },
    };
  }

  it("detects draft from Front context and updates statusLine", async () => {
    const mockFront = createMockFront();
    const container = document.createElement("div");

    const plugin = initFrontPlugin({
      front: mockFront,
      root: container,
      customSettings: {
        overturn_base_url: "https://api.overturn.run",
        agent: "support-reply",
      },
    });

    const statusEl = container.querySelector(".status");
    expect(statusEl?.textContent).toBe("Waiting for a draft");

    // Emit singleConversation with draftId
    mockFront.emit({
      type: "singleConversation",
      conversation: {
        id: "cnv_999",
        subject: "Claim inquiry",
        recipient: { name: "Alice", handle: "alice@example.com" },
        draftId: "dra_123",
      },
      teammate: { id: "tea_1", email: "bob@agent.com", name: "Bob" },
      fetchDraft: async () => ({
        id: "dra_123",
        content: { body: longDraft, type: "text" },
      }),
      listMessages: async () => ({ results: [] }),
    });

    // Wait a tick for async handleContext
    await new Promise((r) => setTimeout(r, 10));

    expect(statusEl?.textContent).toContain("Draft found in the composer · 22 words");
    expect(plugin.getDraft()?.text).toBe(longDraft);
    expect(plugin.getDraft()?.origin).toBe("preloaded");

    plugin.destroy();
  });

  it("honours require_reason by blocking changed reply until reason code is picked", async () => {
    const mockFront = createMockFront();
    const container = document.createElement("div");
    let capturedBody: CaptureCreate | null = null;

    const mockFetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      if (typeof url === "string" && url.endsWith("/v1/capture")) {
        capturedBody = JSON.parse(init?.body as string) as CaptureCreate;
        return {
          ok: true,
          json: async () => ({ kind: "edit", changed: true, deduplicated: false }),
        } as Response;
      }
      return { ok: false, status: 404 } as Response;
    });

    const plugin = initFrontPlugin({
      front: mockFront,
      root: container,
      fetchFn: mockFetch as unknown as typeof fetch,
      customSettings: {
        require_reason: "true",
        reason_pack: "support",
      },
    });

    mockFront.emit({
      type: "messageComposer",
      conversation: { id: "cnv_999", subject: "Water leak" },
      draft: { id: "dra_1", content: { body: longDraft, type: "text" } },
      teammate: { id: "tea_1", email: "bob@agent.com" },
      listMessages: async () => ({
        results: [
          {
            id: "msg_in_1",
            content: { body: "My ceiling is leaking", type: "text" },
            status: "inbound",
            from: { handle: "alice@example.com" },
          },
        ],
      }),
    });

    await new Promise((r) => setTimeout(r, 10));

    const changedText = longDraft.replace("5 business days", "2 business days");

    // Send changed text without picking reason -> must throw/block
    await expect(plugin.triggerSend(changedText)).rejects.toThrow("Overturn: pick why you changed");

    // Now pick a reason code by clicking a chip
    const wrongAnswerChip = container.querySelector(
      'button[data-code="wrong_answer"]',
    ) as HTMLButtonElement | null;
    expect(wrongAnswerChip).not.toBeNull();
    wrongAnswerChip?.click();

    // Now send again -> should succeed
    const res = await plugin.triggerSend(changedText);
    expect(res).toBe(true);

    expect(capturedBody).not.toBeNull();
    const body = capturedBody as unknown as CaptureCreate;
    expect(body.source).toBe("front");
    expect(body.externalId).toBe("fr:cnv_999");
    expect(body.reasonCode).toBe("wrong_answer");
    expect(body.context).toHaveLength(1);
    expect(body.context[0]?.role).toBe("customer");
    expect(body.context[0]?.content).toBe("My ceiling is leaking");

    plugin.destroy();
  });

  it("never blocks the send when /v1/capture fails (logs error and gets out of the way)", async () => {
    const mockFront = createMockFront();
    const container = document.createElement("div");
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const mockFetch = vi.fn(async () => {
      // Simulate network or 500 error on capture endpoint
      return {
        ok: false,
        status: 500,
        text: async () => "Internal Server Error",
      } as Response;
    });

    const plugin = initFrontPlugin({
      front: mockFront,
      root: container,
      fetchFn: mockFetch as unknown as typeof fetch,
      customSettings: {
        require_reason: "false",
      },
    });

    mockFront.emit({
      type: "messageComposer",
      conversation: { id: "cnv_err_1" },
      draft: { id: "dra_1", content: { body: longDraft, type: "text" } },
    });

    await new Promise((r) => setTimeout(r, 10));

    // Send unchanged or changed reply; even with failed capture, triggerSend returns true without throwing
    const result = await plugin.triggerSend(longDraft);
    expect(result).toBe(true);

    expect(consoleSpy).toHaveBeenCalledWith("Overturn capture failed with HTTP status", 500);

    const noteEl = container.querySelector(".note");
    expect(noteEl?.textContent).toContain("Overturn could not save this correction (500)");

    consoleSpy.mockRestore();
    plugin.destroy();
  });

  it("honours scope_tag setting and skips untagged conversations", async () => {
    const mockFront = createMockFront();
    const container = document.createElement("div");

    initFrontPlugin({
      front: mockFront,
      root: container,
      customSettings: {
        scope_tag: "needs_ai_qa",
      },
    });

    const statusEl = container.querySelector(".status");

    mockFront.emit({
      type: "singleConversation",
      conversation: {
        id: "cnv_untagged",
        tags: [{ id: "tag_1", name: "general" }],
        draftId: "dra_1",
      },
      fetchDraft: async () => ({ id: "dra_1", content: { body: longDraft, type: "text" } }),
    });

    await new Promise((r) => setTimeout(r, 10));

    expect(statusEl?.textContent).toBe('Not watching: no "needs_ai_qa" tag');

    mockFront.emit({
      type: "singleConversation",
      conversation: {
        id: "cnv_tagged",
        tags: [{ id: "tag_2", name: "needs_ai_qa" }],
        draftId: "dra_1",
      },
      fetchDraft: async () => ({ id: "dra_1", content: { body: longDraft, type: "text" } }),
    });

    await new Promise((r) => setTimeout(r, 10));
    expect(statusEl?.textContent).toContain("Draft found in the composer · 22 words");
  });
});
