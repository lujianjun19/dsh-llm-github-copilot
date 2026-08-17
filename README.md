# dsh-llm-github-copilot

English | [中文](README.zh.md)

GitHub Copilot LLM adapter for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness).

Sign in with your GitHub account and use every Copilot model — including GPT-4.1, Claude Sonnet, Gemini, and GPT-5 family — directly inside DeepSeek Harness. Vision-capable models accept pasted or dragged images in the chat composer.

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

## Features

**Model discovery** — available models are fetched live from `https://api.githubcopilot.com/models` on each login and cached for 5 minutes. No static list to maintain.

**Vision support** — models that declare `supports.vision: true` (e.g. `gpt-4.1`, `gpt-4o`) accept images. Paste or drag a PNG/JPEG/WebP/GIF into the chat composer; the image is attached, persisted, and visible in history after reload.

**Two wire protocols** — the adapter speaks both OpenAI Chat Completions (`/chat/completions`) and the newer Responses API (`/responses`). The correct endpoint is chosen automatically per model.

**Reasoning control** — effort levels (`low / medium / high / max`) are forwarded to models that declare them (`gpt-5.x`, Claude thinking budget, Gemini reasoning).

**Automatic token refresh** — the short-lived Copilot API token is renewed transparently before it expires; no action required.

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
    models: []   # optional static fallback catalog; leave empty to use live discovery
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

## License

[MIT](LICENSE)
