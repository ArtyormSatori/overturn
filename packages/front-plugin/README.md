# Overturn for Front

QA for AI-drafted replies, in Front's conversation sidebar. It watches the composer for the AI draft, diffs it against what the agent actually sends, asks for a one-line reason, and posts the result to `POST /v1/capture`. The draft becomes a recorded run, the difference becomes a case, and the suite replays it against any model before the next prompt or model change. The drafting agent never has to be instrumented, and it does not matter who wrote the draft: Front's AI answers, a homegrown drafter, or an AI copilot.

## What the agent sees

A small panel in the Front conversation sidebar:

- **Draft inserted · 112 words** once an AI assist, macro or paste lands in the composer. If the drafting agent recorded its run with the Overturn SDK (`externalId: "fr:<conversation id>"`), the draft is taken from that run instead. "Use the current text as the draft" marks it by hand.
- A **reason** box with quick picks (`claims` pack or `support` pack: wrong coverage decision, wrong amount or date, missing required step, tone / wording, policy exception, etc.).
- On **Send**: sent as drafted → an `approve` capture, no prompt; changed → an `edit` capture with the reason as the case's title and the judge's rubric. With *require a reason* on, a changed reply cannot be sent without one.

Overturn failing never blocks the agent's work; errors are logged and the plugin gets out of the way.

## Install

1. In Overturn, create a project API key (Settings → API keys).
2. Build: `pnpm --filter @overturn-ai/front-plugin build` → `dist/overturn-front-plugin.zip`.
3. In Front:
   - Go to **Settings** → **Company** → **Plugins & API** → **Add a plugin**.
   - Select **Sidebar plugin**.
   - Provide the plugin URL (or hosted static bundle) or upload the manifest.
4. Settings:
   - `overturn_api_key`: API key for Overturn project
   - `overturn_base_url`: API URL (default: `https://api.overturn.run`)
   - `reason_pack`: `support` (default) or `claims`, the one-click reasons agents see
   - `agent`: the workflow name, one regression suite per workflow (default: `support-reply`)
   - `decision_fields`: custom fields that *are* the decision, e.g. `status, priority`
   - `require_reason`: boolean, require picking a reason before sending a changed reply
   - `min_draft_chars`: minimum characters to consider text a draft (default: 80)
   - `scope_tag`: optional Front tag name (e.g. `ai-drafted`); when set, only conversations with this tag are watched

## Development

```bash
pnpm --filter @overturn-ai/front-plugin test      # draft detection, diff, send decision & mocked SDK
pnpm --filter @overturn-ai/front-plugin build     # bundles iframe assets into dist/overturn-front-plugin.zip
```

`src/capture.ts` is the pure capture & decision logic; `src/main.ts` is the Front Plugin SDK bridge; `plugin/` contains manifest, HTML, and styling.
