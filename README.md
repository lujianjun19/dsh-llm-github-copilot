# dsh-llm-github-copilot

English | [中文](README.zh.md)

GitHub Copilot LLM adapter for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness).

Sign in with your GitHub account and use every Copilot model — including GPT-4.1, Claude Sonnet, Gemini, and GPT-5 family — directly inside DeepSeek Harness. Vision-capable models accept pasted or dragged images in the chat composer, images from `/goal` and `/plan`, and images returned by tools such as `read_image` and MCP servers.

## Requirements

- **DeepSeek Harness `0.1.1-rc.2` or `0.1.2-alpha.1`.** Both are supported: the
  adapter probes the loaded `@deepseek-ai/dsh-llm` and selects the matching
  calling convention. Note that `0.1.2-alpha.1` renamed `CallId` to
  `ToolCallId`, changed the `requestImageHandleText` signature, and made the
  request-image offload placeholder caller-supplied — so **plugin versions
  `≤ 0.4.2` do not load on `0.1.2-alpha.1`**. Upgrade this plugin together with
  the harness.
- The vision path uses native image APIs (`AttachmentStore.readImageRequest`,
  `offloadRequestImagesWithPolicy`, `requestImageHandleText`) introduced in
  `0.1.1-rc.2`; `0.1.0-rc.x` and earlier lack them and will not run this
  adapter. Upgrade with `npm install -g @deepseek-ai/dsh@latest`.
- Node.js ≥ 24.

## Install

### From npm (recommended)

```sh
dsh plugin --profile web add @lujianjun19/dsh-llm-github-copilot
```

### From GitHub

```sh
dsh plugin --profile web add github:lujianjun19/dsh-llm-github-copilot
```

pnpm 10 and newer block git dependency build scripts by default. If installation asks you to approve the package build, add the exact package key it reports to the profile's `pnpm-workspace.yaml`:

```yaml
allowBuilds:
  dsh-llm-github-copilot: true
```

Then repeat the install command.

After installation, register the plugin in the profile's `cordis.patch.yml`:

```yaml
- insert:
    - id: llm-github-copilot
      name: '@lujianjun19/dsh-llm-github-copilot'
```

Restart DSH to activate:

```sh
dsh web
```

## Update

The DSH profile uses pnpm internally, and its lockfile pins the exact installed version. Re-running `dsh plugin add` alone may not pick up a newer release. Use either of the following commands from any directory:

```sh
# Using npm (simplest — no extra flags needed)
npm install --prefix ~/.dsh/profiles/web @lujianjun19/dsh-llm-github-copilot@latest

# Using pnpm
pnpm add --dir ~/.dsh/profiles/web @lujianjun19/dsh-llm-github-copilot@latest --no-frozen-lockfile
```

Then restart DSH:

```sh
dsh web
```

To confirm the installed version, open **Settings → GitHub Copilot** in the Harness browser UI — the version number is shown at the bottom of the panel.

## Sign in

Run the login command inside the Harness chat:

```
/copilot-login
```

Follow the instructions — open the verification URL in your browser, enter the displayed code, and authorize the GitHub App. The token is stored automatically once you complete authorization. Run `/copilot-status` to confirm the connection and see the available models.

To sign out:

```
/copilot-logout
```

You can also set the token directly as an environment variable (useful for CI or headless setups):

```sh
export GITHUB_COPILOT_OAUTH_TOKEN=<your-github-oauth-token>
```

**Supported token types:**

| Prefix | Source |
|--------|--------|
| `gho_` | OAuth token (`gh auth login`) |
| `github_pat_` | Fine-grained PAT (requires **Copilot** permission) |
| `ghu_` | GitHub App user token (VS Code client) |

`ghp_` classic PATs are not accepted by the Copilot API.

## Features

**Model discovery** — available models are fetched live from `https://api.githubcopilot.com/models` on each login and cached for 5 minutes. No static list to maintain.

**Vision support** — models that declare `supports.vision: true` (e.g. `gpt-4.1`, `gpt-4o`) accept images from every source Harness produces: pasted or dragged images in the composer, `/goal` and `/plan` attachments, and tool-result images (`read_image`, MCP servers). Images are derived per model route through the Harness attachment service (`readImageRequest`), tagged with a stable handle, and sent over both wire protocols. When a request exceeds a model's image count or the local inline byte budget, older request images are offloaded first while the current user submission and the latest tool-result batch are protected; a stable placeholder marks any omitted image without altering the durable history. Set `imageOverflowPolicy: error` to reject over-limit requests instead.

**Recoverable images** — on Harness `0.1.2-alpha.1` and newer, every image the model sees is annotated with a read-only path to its normalized copy in the tool execution world. The model receives a downscaled preview but can re-read the full file when it needs detail, and an image offloaded to fit a request limit stays recoverable instead of being simply gone. The path resolves through the Harness filesystem provider, so workspace and sandbox confinement still apply; when no mapping exists the annotation is omitted and nothing else changes.

**Two wire protocols** — the adapter speaks both OpenAI Chat Completions (`/chat/completions`) and the newer Responses API (`/responses`). The correct endpoint is chosen automatically per model.

**Reasoning control** — effort levels (`low / medium / high / max`) are forwarded to models that declare them (`gpt-5.x`, Claude thinking budget, Gemini reasoning).

**Automatic token refresh** — the short-lived Copilot API token is renewed transparently before it expires; no action required.

**Turn token usage** — every response reports the provider's exact token accounting, including its own total, so the Harness **Turn usage** panel (`0.1.2-alpha.1` and newer) shows uncached input, cached input, output, reasoning, and the cache hit rate for each turn.

**Settings page** — the plugin adds a dedicated **GitHub Copilot** section to the Harness Web settings UI (open DSH in your browser → click the gear icon → **GitHub Copilot**). From there you can sign in, view authentication status and the available model list, and sign out — no slash commands required.

## Configure

The plugin works with no configuration. To override defaults, edit the profile's `cordis.patch.yml`:

```yaml
- id: llm-github-copilot
  config:
    oauthTokenEnv: GITHUB_COPILOT_OAUTH_TOKEN   # env var that holds the GitHub OAuth token
    baseURL: https://api.githubcopilot.com       # override Copilot API host
    defaultContextWindow: 262144
    defaultMaxTokens: 32768
    streamIdleTimeoutMs: 300000
    imageOverflowPolicy: offload-oldest         # offload-oldest | error
    defaultImagePixelBudget: 4194304            # request-image pixel budget (2048×2048)
    maxInlineRequestImageBytes: 20971520        # total Base64 request-image budget (20 MiB)
    inlineImageOffloadByteQuantum: 10485760     # oldest-image removal step (10 MiB)
    models: []   # optional static fallback catalog; leave empty to use live discovery
```

Static fallback models may declare vision capability explicitly (used only when
live `/models` discovery fails); capability is never inferred from a model name:

```yaml
    models:
      - id: custom-vision-model
        inputModalities: [text, image]
        vision:
          maxImageBytes: 3145728
          maxImages: 1
          mediaTypes: [image/jpeg, image/png, image/webp]
          imagePixelBudget: 4194304
```

## Develop

Requires Node.js ≥ 24 and npm.

```sh
cd /path/to/dsh-llm-github-copilot
npm run build      # concatenate source fragments → lib/index.js and lib/client.js
npm test           # build + deterministic artifact, i18n, and metadata tests
npm run check      # build + tests + npm pack dry-run
npm run deploy     # test → build → atomic deploy with rollback backup
```

Install the checkout into a local profile directly:

```sh
dsh plugin --profile web add .
```

After Host changes restart DSH; after Client-only changes a hard refresh (`Ctrl+Shift+R`) is usually enough.

## Rollback

`npm run deploy` keeps a timestamped backup before each install. To roll back, stop DSH and restore the wanted backup:

```sh
cp -r ~/.dsh/plugin-backups/dsh-llm-github-copilot/<timestamp> \
      ~/.dsh/profiles/web/node_modules/@lujianjun19/dsh-llm-github-copilot
dsh web
```

## Troubleshooting

**Model selector shows no GitHub Copilot group after restart**
The plugin loaded in a previous process that didn't pick up the new package. Restart `dsh web`. The stored token is preserved; no need to sign in again.

**Models appear but Claude is missing**
Your egress IP is restricted. Export `HTTPS_PROXY` pointing to a proxy that exits from an unrestricted region, then restart `dsh web`.

**`/copilot-login` times out or reports a network error**
Transient network issue during device-code polling. Run `/copilot-login` again to get a fresh code (the old one is invalidated automatically).

**`configurable provider "github-copilot" is already declared`**
An older version of this plugin used the route name `github-copilot`, which conflicts with a DSH built-in. This version uses `github-copilot-official`. Verify that your `cordis.patch.yml` uses `id: llm-github-copilot` and `name: '@lujianjun19/dsh-llm-github-copilot'`.

**Token expired**
No action needed. The plugin stores the long-lived GitHub OAuth token and refreshes the short-lived Copilot API token automatically before it expires. Only an explicit sign-out or token revocation requires a new `/copilot-login`.

## License

[MIT](LICENSE)
