# Changelog

All notable changes to this project are documented here. The project follows Semantic Versioning.

## [0.3.9] - 2026-08-19

### Added

- **Settings › GitHub Copilot tab: plugin version display**
  The bottom of the GitHub Copilot settings panel now shows the installed plugin
  version as a `Plugin version:` / `插件版本：` label followed by a clickable
  `@lujianjun19/dsh-llm-github-copilot vX.Y.Z` link that opens the corresponding
  GitHub Releases tag page. The version is injected at build time from
  `package.json` — no runtime API calls are needed.

## [0.3.8] - 2026-08-19

### Changed

- Extracted `BlockStream` reducer shared by both SSE translators; eliminates
  duplicate block-accumulator logic between the chat-completions and Responses
  API paths. `BlockStream` and `translate` are now exported for direct testing.
- Introduced `WireProtocol` seam (`chatProtocol` / `responsesProtocol` /
  `selectProtocol`) in `07-wire-protocol.js`; the three independent
  `useResponses` ternaries in `request()` are replaced by a single protocol
  object.
- Centralized chat-completions reasoning-field names in `chatReasoningFrom()`;
  `translate()` and `traceSse()` now share a single field list.
- Unified empty-response rule across both wire formats; error-kind finish
  reasons from the chat path now preserve their specific error message.
- Fixed reverse fragment dependency: `reasoningMetadata` / `wireReasoning`
  moved from `08-adapter.js` to `07-wire-protocol.js` so dependency direction
  matches file ordering.

## [0.3.7] - 2026-08-19

### Fixed

- **gpt-5.x dual-endpoint models (gpt-5.4, gpt-5-mini): empty Think block — reasoning hidden on `/chat/completions`**

  Models that advertise BOTH `/responses` and `/chat/completions` (currently
  `gpt-5.4` and `gpt-5-mini`) were routed to `/chat/completions`, where GitHub
  Copilot does **not** stream the reasoning text — the response reports
  `reasoning_tokens` in usage (e.g. 1792) but emits zero `reasoning_text`
  chunks, so the Think block stayed empty even though the model reasoned
  heavily. The `/responses`-only gpt-5.x models (gpt-5.4-mini, gpt-5.5,
  gpt-5.6-*) were unaffected because they already used the Responses API.

  **Fix:** the adapter now prefers `/responses` whenever a model offers it
  (`useResponses = endpoints.includes("/responses")`), instead of only when
  `/chat/completions` is absent. Verified at the wire level: on `/responses`
  with `reasoning.summary: "detailed"`, gpt-5.4 streamed 475 B of reasoning
  (87 deltas) and gpt-5-mini 1344 B (280 deltas across 3 summary parts) — both
  now drive a live Think block exactly like gpt-5.6-luna. Chat-only models
  (kimi-k3, gpt-4o, gemini-*) are unchanged.

  A diagnostic tap (`traceSse`, gated behind the `DSH_COPILOT_TRACE`
  environment variable) was added to log the reasoning events/fields each model
  emits on both wire formats; it produces no output and has zero overhead when
  the variable is unset.

- **Responses API (gpt-5.x, e.g. gpt-5.6 "luna"): Think block appeared but never updated + a stream-invariant error**

  Two distinct bugs in `translateResponses()`:

  1. **Think content "not dynamically changing".** GitHub Copilot's gpt-5.x
     `/responses` stream delivers raw reasoning as
     `response.reasoning_text.delta` (the same `reasoning_text` field naming
     already recognised for chat-completions in the Claude fix), *not* the
     `response.reasoning_summary_text.delta` variant the translator handled.
     The reasoning block was therefore opened (`block-start`) and closed
     (`block-end`) with **zero** `reasoning-delta` chunks in between — the Think
     row rendered but its content never streamed. The translator now handles
     `response.reasoning_text.delta`/`.done` alongside the summary events, and
     backfills from the terminal `.done` text when an endpoint sends no deltas.

  2. **Stream-invariant error on text output.** When a `response.output_text.delta`
     arrived without a preceding `response.content_part.added`, the old
     `ensureText()` opened a text block but emitted no `block-start`, so the
     following `text-delta` addressed a block the harness never saw open. The
     `@deepseek-ai/dsh-llm` stream invariant rejected it
     (`text delta ... requires an open text block`), throwing an `InvariantError`
     that surfaced as an error message and aborted the stream. Text block-start
     is now emitted lazily and exactly once from whichever event opens the block.

  New regression tests in `tests/responses-reasoning-stream.test.mjs` cover raw
  `reasoning_text` streaming, `.done`-only backfill, and the missing
  `content_part.added` case.

## [0.3.12] - 2026-08-18

### Fixed

- **Responses API (gpt-5.x): tool-call arguments dropped → `presenter failed for tool/call: Unexpected end of JSON input`**

  Same opaque-`item_id` mismatch as the reasoning bug, but for tool calls:
  gpt-5.x assigns a **different** id to `output_item.added`,
  `function_call_arguments.delta`, `function_call_arguments.done`, and
  `output_item.done`. Matching the tool-call block by `toolBlocks.get(item_id)`
  never hit, so **every argument delta was dropped** and the block's `arguments`
  stayed empty. The client then did `JSON.parse("")`, throwing
  `Unexpected end of JSON input` and falling back to a generic card
  (`api-proxy: presenter failed for tool/call`).

  **Fix:** `translateResponses()` now tracks the current open tool-call block by
  reference (`toolBlock`) and routes argument deltas / `.done` / close through it
  instead of the mismatched id. Verified against the live stream: the
  authoritative complete arguments arrive on `function_call_arguments.done` and
  `output_item.done`, both now correctly applied. New file
  `tests/responses-toolcall-stream.test.mjs` adds 4 regression tests.

## [0.3.11] - 2026-08-18

### Changed

- **Responses API (gpt-5.x): use `reasoning.summary: "detailed"` instead of `"concise"`**

  With `"concise"`, GitHub Copilot's gpt-5.x emits only a single one-line title
  per reasoning step (e.g. `**Checking user input relevance**`, ~25-34 chars),
  which made the Think block look like it was "stuck" after one short line even
  though the block-start/delta/block-end cycle was completing correctly.
  `"detailed"` yields multi-sentence summaries per step, so the Think block now
  shows substantive reasoning content.

  Diagnosed via event-stream tracing: each reasoning segment correctly produced
  `block-start → reasoning-delta → block-end`; the perceived "stuck" state was
  purely the one-line concise summary, not a streaming bug.

## [0.3.10] - 2026-08-18

### Fixed

- **Responses API (gpt-5.x): Think block stuck after first segment — reasoning routed by mismatched opaque `item_id`**

  GitHub Copilot's gpt-5.x (`/responses`) stream assigns a **different** opaque
  `item_id` to every reasoning event: `output_item.added`,
  `reasoning_summary_part.added`, `reasoning_summary_text.delta`, and
  `output_item.done` each carry a distinct encrypted token. The translator
  matched reasoning blocks by `reasoningBlocks.get(item_id)`, which therefore
  never hit:

  - `output_item.done` could not find the block, so `block-end` was never
    emitted — the Think row stayed "streaming" forever (appeared stuck), and
  - later reasoning segments fell back to the first still-open block via
    `order.find`, corrupting multi-segment display.

  **Fix:** `translateResponses()` now tracks the current open reasoning block by
  reference (`reasoningBlock`) instead of by id. Reasoning items are sequential
  and non-overlapping, so a single reference routes every delta and closes the
  block reliably. Multiple summary parts within one item are separated by a
  blank line. New file `tests/responses-reasoning-stream.test.mjs` adds 6
  regression tests replaying the mismatched-id event pattern.

  `translateResponses` is now exported from `lib/index.js` for testing.

## [0.3.9] - 2026-08-18

### Fixed

- **Responses API (GPT-5.x): Think block never appeared — missing `summary` field**

  The Responses API only emits `response.reasoning_summary_text.delta` streaming
  events when the request includes `reasoning.summary`. Without it the stream
  carries no reasoning content regardless of effort level, so the Think block
  never appeared in the UI.

  **Fix:** `serializeResponsesRequest()` now always includes
  `reasoning: { summary: "concise" }` when the model declares reasoning
  capability (`supportsReasoning`), even when no explicit effort is selected.
  When an effort is selected it is included alongside `summary`.

## [0.3.8] - 2026-08-18

### Fixed

- **Chat-completions: Claude `reasoning_text` delta field not recognised**

  GitHub Copilot proxies Claude's thinking content using the field name
  `reasoning_text` in streaming deltas, while the adapter only checked
  `reasoning_content` and `reasoning`.  As a result no `reasoning-delta`
  chunks were emitted and the Think block never appeared in the UI.

  **Fix:** `translate()` in `04-sse-translate.js` now checks
  `reasoning_text` as the second candidate (after `reasoning_content`,
  before `reasoning`), matching the actual field name GitHub Copilot uses.

  `serializeAssistant()` also serialises prior reasoning turns under both
  `reasoning_content` and `reasoning_text` for round-trip compatibility.

## [0.3.7] - 2026-08-18

### Fixed

- **Responses API: tool calls serialized as top-level `function_call` items**
  ([#bug](https://github.com/lujianjun19/dsh-llm-github-copilot))

  When a conversation contained a prior assistant tool call (i.e. any second+
  turn using a tool), the adapter placed tool calls inside the assistant
  message's `content` array with `type: "output_tool_call"`.  The Responses API
  rejects this with:

  > "Invalid value: 'output_tool_call'. Supported values are: 'output_text', …"

  **Root cause:** `OutputMessageContent` only accepts `output_text` and
  `refusal`.  Tool calls must be top-level `input[]` items with
  `type: "function_call"`, not nested inside any message.

  **Fix:** `serializeResponsesMessages()` now emits each tool call as an
  independent top-level `{ type: "function_call", id, call_id, name, arguments
  }` item and omits the assistant `message` item entirely when the turn
  contains only tool calls (no text).

  Only the gpt-5.x family is affected (models routed through `/responses`).
  Chat-Completions models (gpt-4.x, claude, gemini, …) are unaffected.

  5 new regression tests added to `vision-responses-serialize.test.mjs`.

## [0.3.6] - 2026-08-18

### Fixed

- Remove `bundledDependencies` 2014 it caused `github:` source installs to skip
  installing runtime deps (pnpm treats bundled deps as already present).
  All three install paths now work correctly: `npm run deploy`, `npm publish`,
  and `dsh plugin add github:`.


## [0.3.5] - 2026-08-18

### Fixed

- `client.js` module id was still `@deepseek-ai/dsh-llm-github-copilot`; updated
  to `@lujianjun19/dsh-llm-github-copilot` to match the installed package name.
  DSH rejected the bundle at browser startup with "loaded without registering".

## [0.3.4] - 2026-08-18

### Fixed

- Include `cordis.patch.yml` in `package.json` `files` and `scripts/deploy.mjs`
  `releaseEntries`. When installed via `dsh plugin add github:...`, DSH loads
  the package as a bundle and requires the file declared by `dsh.bundle.patch`
  to be present — it was missing and caused a boot-time `ENOENT` error.

## [0.3.3] - 2026-08-18

### Changed

- Replace `vendor/undici` with a proper npm `dependency`; `deploy.mjs` now
  bundles runtime deps from local `node_modules/` instead of a hand-copied
  vendor tree. `bundledDependencies` ensures the same packages are included
  in the npm publish tarball.
- Fix `deploy.mjs` release entries: swap removed `INSTALL.md` for `README.zh.md`.

## [0.3.2] - 2026-08-18

### Changed

- Merge INSTALL content into README and remove standalone INSTALL files.
- Remove debug step from release workflow.

## [0.3.1] - 2026-08-17

### Changed

- Switch to npm Trusted Publishing (OIDC) — no long-lived token required for CI/CD publish.
- Fix repository.url format in package.json to match GitHub URL exactly.
- Add package-lock.json for reproducible CI installs.

## [0.3.0] - 2026-08-17

### Added

- **Vision model support (Workflow A)**: Dynamic discovery of GitHub Copilot models with `capabilities.supports.vision === true`.
- `readModelsListing()` now parses vision limits (`max_prompt_image_size`, `max_prompt_images`, `supported_media_types`) from `/models` into a structured `vision` field per catalog entry.
- Models with `supports.vision === true` are declared with `inputModalities: ['text', 'image']`; all others remain `['text']`. No name-based inference.
- New `src/host/04-attachment-resolver.js`: `createImageResolver()` reads images from the DSH `AttachmentStore`, validates MIME type, byte size, and per-request unique image count against model-level limits, and produces Base64 data URIs for Provider wire payloads.
- `serializeRequest()` (Chat Completions) is now async and supports `image_url` content parts for user messages; pure-text messages retain the string `content` shape for provider-cache compatibility.
- `serializeResponsesRequest()` (Responses API) is now async and supports `input_image` items for user messages.
- System, assistant, and tool-result positions reject image content with explicit `UNSUPPORTED_CONTENT` errors.
- The adapter's `request()` method performs an image pre-flight check: model modality gate → attachment-service presence → per-resolver MIME/size/count validation.
- `resolveAttachments: () => ctx.get('attachments')` added to the adapter config in `apply()`; the attachment service is resolved lazily only when a request contains images.
- 47 new unit tests across `vision-catalog`, `vision-chat-serialize`, `vision-responses-serialize`, and `vision-adapter` test files.

### Changed

- `modelInfo()` now reads `model.inputModalities ?? ["text"]` instead of hardcoding `["text"]`.
- `resolveModel()` fallback for unconfigured models still uses `["text"]`; dynamic models use the catalog-resolved modalities.
- `serializeMessages()` and `serializeResponsesMessages()` are now async.
- Additional exports for internal testing: `readModelsListing`, `createImageResolver`, `serializeRequest`, `serializeResponsesRequest`.

## [0.2.1] - 2026-08-17

### Added

- Self-contained implementation handoff for Copilot vision support and the separate document-reading tool.
- Release packaging and deployment of repository governance and design documents.

## [0.2.0] - 2026-08-17

### Added

- GitHub OAuth device-flow login, status, and logout commands.
- Harness-styled GitHub Copilot Settings page with English and Chinese localization.
- Automatic login-dialog close after OAuth credential commit.
- Automatic model-directory refresh after credential changes.
- Logout confirmation through the Harness popup and risk-confirmation components.
- GitHub Copilot Settings navigation icon.
- Deterministic source-fragment build, tests, atomic deployment, packaging, and Git workflow.

### Changed

- Unauthenticated and failed-auth catalogs no longer advertise unusable fallback models.
- Source ownership moved from the live DSH profile to this repository.
