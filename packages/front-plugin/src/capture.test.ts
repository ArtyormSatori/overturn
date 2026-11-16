import { describe, expect, it } from "vitest";
import {
  type ConversationSnapshot,
  contextFrom,
  createDraftDetector,
  DEFAULT_SETTINGS,
  decideOnSend,
  inScope,
  quickReasons,
  settingsFrom,
  statusLine,
  stripHtml,
} from "./capture";

const draftText =
  "<p>Hi Dana,</p><p>Thanks for the photos. Storm damage to the roof is covered under your HO-3 policy. An adjuster will contact you within 5 business days.</p>";

const conversation: ConversationSnapshot = {
  id: "cnv_48213",
  subject: "Roof leak after storm",
  recipientEmail: "dana@example.com",
  recipientName: "Dana",
  messages: [
    {
      id: "msg_1",
      body: "<div>Water came through the ceiling.<br>Photos attached.</div>",
      type: "inbound",
      authorEmail: "dana@example.com",
      isAgent: false,
      createdAt: "2026-10-01T10:00:00Z",
    },
    {
      id: "msg_2",
      body: "HO-3, no prior claims.",
      type: "comment",
      authorName: "Ray",
      isAgent: true,
      createdAt: "2026-10-01T10:05:00Z",
    },
  ],
  fields: {},
  url: "https://app.frontapp.com/open/cnv_48213",
};

describe("settings", () => {
  it("parses the configuration parameters", () => {
    const s = settingsFrom({
      overturn_base_url: "https://ov.internal/",
      overturn_api_key: "sec_test_123",
      agent: "claims-reply",
      require_reason: "true",
      decision_fields: "custom_field_1:status, custom_field_2:reserve,custom_field_3",
      min_draft_chars: "120",
    });
    expect(s.baseUrl).toBe("https://ov.internal");
    expect(s.apiKey).toBe("sec_test_123");
    expect(s.agent).toBe("claims-reply");
    expect(s.requireReason).toBe(true);
    expect(s.decisionFields).toEqual([
      { id: "custom_field_1", label: "status" },
      { id: "custom_field_2", label: "reserve" },
      { id: "custom_field_3", label: "custom_field_3" },
    ]);
    expect(s.minDraftChars).toBe(120);
  });

  it("scope tag limits which conversations are watched", () => {
    expect(inScope(["billing"], DEFAULT_SETTINGS)).toBe(true);
    const scoped = settingsFrom({ scope_tag: "ai_drafted" });
    expect(scoped.scopeTag).toBe("ai_drafted");
    expect(inScope(["billing"], scoped)).toBe(false);
    expect(inScope(["billing", "ai_drafted"], scoped)).toBe(true);
  });

  it("reason_pack selects the chips: support by default, claims for claims pack", () => {
    expect(quickReasons(DEFAULT_SETTINGS).map((r) => r.code)).toContain("wrong_answer");
    const claims = quickReasons(settingsFrom({ reason_pack: "claims" })).map((r) => r.code);
    expect(claims).toContain("wrong_coverage_decision");
    expect(claims).toContain("reserve_too_low");
    expect(claims).toHaveLength(8);

    const support = quickReasons(settingsFrom({ reason_pack: "support" })).map((r) => r.code);
    expect(support).toContain("wrong_answer");
    expect(support).toContain("should_escalate");
    expect(support).not.toContain("reserve_too_low");
    expect(support).toContain("tone_wording");

    expect(settingsFrom({ reason_pack: "invalid_pack" }).reasonPack).toBe("support");
  });

  it("falls back to defaults", () => {
    expect(settingsFrom({})).toEqual(DEFAULT_SETTINGS);
    expect(settingsFrom({ require_reason: "false" }).requireReason).toBe(false);
  });
});

describe("draft detection", () => {
  const long = "x".repeat(200);

  it("a reply-sized insert into an empty composer is the draft; typing is not", () => {
    const d = createDraftDetector({ minDraftChars: 80 });
    expect(d.onComposer("", 0)).toBeNull();
    let text = "";
    for (let i = 1; i <= 100; i++) {
      text += "ab";
      expect(d.onComposer(text, i * 100)).toBeNull();
    }
    expect(d.current()).toBeNull();

    const d2 = createDraftDetector({ minDraftChars: 80 });
    d2.onComposer("", 0);
    expect(d2.onComposer(long, 500)?.origin).toBe("inserted");
    expect(d2.onComposer(`${long} more`, 600)).toBeNull();
  });

  it("preloaded draft detection when composer already has text on first sight", () => {
    const d = createDraftDetector({ minDraftChars: 80 });
    const draft = d.onComposer(long, 100);
    expect(draft?.origin).toBe("preloaded");
    expect(draft?.text).toBe(long);
  });

  it("manual draft can be set directly", () => {
    const d = createDraftDetector({ minDraftChars: 80 });
    d.set({ text: "Manual draft here", origin: "manual", at: 1000 });
    expect(d.current()?.origin).toBe("manual");
    expect(d.current()?.text).toBe("Manual draft here");
  });
});

describe("context and stripHtml", () => {
  it("normalizes html to plain text", () => {
    expect(stripHtml("Hello<br>World&amp;Everyone")).toBe("Hello\nWorld&Everyone");
    expect(stripHtml("<p>First</p><p>Second</p>")).toBe("First\nSecond");
  });

  it("contextFrom maps Front messages and comments to CaptureMessage[]", () => {
    const ctx = contextFrom(conversation);
    expect(ctx).toHaveLength(2);
    expect(ctx[0]?.role).toBe("customer");
    expect(ctx[0]?.author).toBe("dana@example.com");
    expect(ctx[0]?.content).toContain("Water came through the ceiling.");
    expect(ctx[1]?.role).toBe("note");
    expect(ctx[1]?.author).toBe("Ray");
    expect(ctx[1]?.content).toBe("HO-3, no prior claims.");
  });
});

describe("decideOnSend", () => {
  const base = {
    conversation,
    draft: { text: draftText, origin: "inserted" as const, at: 1000 },
    draftFields: {},
    reasonCode: null,
    reason: "",
    actor: "agent@company.com",
    settings: DEFAULT_SETTINGS,
  };

  it("skips when there is no draft", () => {
    const d = decideOnSend({
      ...base,
      draft: null,
      send: { text: "Hello", type: "outbound", fields: {} },
    });
    expect(d).toEqual({ action: "skip", why: "no-draft" });
  });

  it("skips when sent text is empty", () => {
    const d = decideOnSend({
      ...base,
      send: { text: "   ", type: "outbound", fields: {} },
    });
    expect(d).toEqual({ action: "skip", why: "empty" });
  });

  it("skips internal notes unless captureInternalNotes is enabled", () => {
    const skipped = decideOnSend({
      ...base,
      send: { text: "Internal note", type: "comment", fields: {} },
    });
    expect(skipped).toEqual({ action: "skip", why: "internal-note" });

    const captured = decideOnSend({
      ...base,
      settings: { ...DEFAULT_SETTINGS, captureInternalNotes: true },
      send: { text: draftText, type: "comment", fields: {} },
    });
    expect(captured.action).toBe("capture");
  });

  it("an unchanged reply is an approved capture with source 'front' and externalId 'fr:<id>'", () => {
    const d = decideOnSend({
      ...base,
      send: { text: draftText, type: "outbound", fields: {} },
    });
    expect(d.action).toBe("capture");
    if (d.action !== "capture") return;
    expect(d.changed).toBe(false);
    expect(d.body.source).toBe("front");
    expect(d.body.externalId).toBe("fr:cnv_48213");
    expect(d.body.agent).toBe("support-reply");
    expect(d.body.draft.text).toBe(d.body.sent.text);
    expect(d.body.tags).toEqual(["draft:inserted", "outbound"]);
    expect(typeof d.body.secondsToSend).toBe("number");
    expect(d.body.context).toHaveLength(2);
  });

  it("a changed reply is an edit capture carrying the reason code and note", () => {
    const sent = draftText.replace("5 business days", "2 business days");
    const d = decideOnSend({
      ...base,
      reasonCode: "wrong_amount_or_date",
      reason: "Storm SLA is 2 days",
      send: { text: sent, type: "outbound", fields: {} },
    });
    expect(d.action).toBe("capture");
    if (d.action !== "capture") return;
    expect(d.changed).toBe(true);
    expect(d.body.source).toBe("front");
    expect(d.body.reason).toBe("Storm SLA is 2 days");
    expect(d.body.reasonCode).toBe("wrong_amount_or_date");
    expect(d.body.sent.text).toContain("2 business days");
    expect(d.body.sent.fields).toBeUndefined();
  });

  it("require_reason blocks a changed send until a reason code is chosen", () => {
    expect(DEFAULT_SETTINGS.requireReason).toBe(true);
    const sent = draftText.replace("covered", "not covered");

    const blocked = decideOnSend({
      ...base,
      send: { text: sent, type: "outbound", fields: {} },
    });
    expect(blocked).toEqual({ action: "need-reason", changedFields: [] });

    const noteOnly = decideOnSend({
      ...base,
      reason: "exclusion",
      send: { text: sent, type: "outbound", fields: {} },
    });
    expect(noteOnly.action).toBe("need-reason");

    const ok = decideOnSend({
      ...base,
      reasonCode: "missed_exclusion",
      send: { text: sent, type: "outbound", fields: {} },
    });
    expect(ok.action).toBe("capture");
    if (ok.action === "capture") {
      expect(ok.body.reasonCode).toBe("missed_exclusion");
    }
  });

  it("decision fields changes are tracked and scored", () => {
    const settings = {
      ...DEFAULT_SETTINGS,
      decisionFields: [{ id: "custom_field_1", label: "status" }],
    };
    const d = decideOnSend({
      ...base,
      settings,
      reasonCode: "wrong_coverage_decision",
      draftFields: { status: "covered" },
      send: { text: draftText, type: "outbound", fields: { status: "denied" } },
    });
    expect(d.action).toBe("capture");
    if (d.action !== "capture") return;
    expect(d.changed).toBe(true);
    expect(d.changedFields).toEqual(["status"]);
    expect(d.body.draft.fields).toEqual({ status: "covered" });
    expect(d.body.sent.fields).toEqual({ status: "denied" });
  });

  it("records how long the draft sat in front of the reviewer", () => {
    const d = decideOnSend({
      ...base,
      draft: { text: draftText, origin: "inserted", at: 10_000 },
      now: 14_250,
      send: { text: draftText, type: "outbound", fields: {} },
    });
    if (d.action !== "capture") throw new Error(d.action);
    expect(d.body.secondsToSend).toBe(4.3);
  });

  it("recorded draft attaches to its run ID and model", () => {
    const d = decideOnSend({
      ...base,
      draft: {
        text: draftText,
        origin: "recorded",
        runId: "0199a0d0-0000-7000-8000-000000000000",
        model: "gpt-4.1-mini",
        at: 1,
      },
      send: { text: draftText, type: "outbound", fields: {} },
    });
    if (d.action !== "capture") throw new Error(d.action);
    expect(d.body.draftRunId).toBe("0199a0d0-0000-7000-8000-000000000000");
    expect(d.body.draftModel).toBe("gpt-4.1-mini");
  });
});

describe("statusLine", () => {
  it("describes the draft and result states", () => {
    expect(statusLine(null, null)).toBe("Waiting for a draft");
    expect(statusLine({ text: "one two three", origin: "manual", at: 1 }, null)).toBe(
      "Draft marked by you · 3 words",
    );
    expect(statusLine(null, { kind: "approve", changed: false, dedup: false })).toBe(
      "Sent as drafted · approved",
    );
    expect(statusLine(null, { kind: "edit", changed: true, dedup: true })).toBe(
      "Captured · already in the suite",
    );
    expect(statusLine(null, { kind: "edit", changed: true, dedup: false })).toBe(
      "Captured · edit saved as a case",
    );
  });
});
