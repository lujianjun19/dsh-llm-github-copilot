# Changelog

All notable changes to this project are documented here. The project follows Semantic Versioning.

## [Unreleased]

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
