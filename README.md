# dsh-llm-github-copilot

English | [中文](README.zh.md)

GitHub Copilot sign-in for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness).

Sign in with your GitHub account and use every Copilot model your plan includes — GPT-5 family, Claude, Gemini, and more — inside DeepSeek Harness.

The harness already ships a `github-copilot` provider that can serve those models; what it cannot do is sign you in. This plugin fills exactly that gap: it runs the GitHub device flow and publishes the credential that provider authenticates from. Requests, model discovery, images, and streaming are all handled by the harness route, not here. See [`docs/adr/0002-narrow-to-credential-provider.md`](docs/adr/0002-narrow-to-credential-provider.md).

## Requirements

- **DeepSeek Harness `0.1.2-alpha.1` or newer**, with its bundled
  `@deepseek-ai/dsh-llm-pi-ai` route (mounted by default). This plugin writes
  the credential that route reads.
- A GitHub account with a Copilot subscription.
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

### GitHub Enterprise

Sign in against a GitHub Enterprise server by passing its domain to the login command:

```
/copilot-login westpac.ghe.com
```

The plugin normalizes URLs and bare hostnames, and stores the domain in the credential record so the harness's Copilot provider exchanges tokens and derives endpoints under that domain instead of github.com. A blank domain (or omitting the argument) signs in against github.com as before.

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

**Device-flow sign-in** — no token to create or paste. Run `/copilot-login`, or use the Settings page, and authorize in the browser; the credential is stored automatically.

**Automatic refresh, handled downstream** — the credential carries your long-lived GitHub token. The harness route exchanges it for a short-lived Copilot token, refreshes it, and derives your account's API endpoint (individual, business, or enterprise) on its own.

**Ambient token adoption** — an existing `GITHUB_COPILOT_OAUTH_TOKEN`, whether exported or stored from an earlier version of this plugin, is adopted on start so you are not asked to sign in twice.

**Settings page** — a dedicated **GitHub Copilot** section in the Harness Web settings UI (gear icon → **GitHub Copilot**) for signing in, checking status, and signing out. Models are selected under **Settings → Models**, in the `github-copilot` provider.

**Slash commands** — `/copilot-login`, `/copilot-status`, and `/copilot-logout` for surfaces without the settings UI.

## Selecting a model

Signing in publishes the credential; it does not pick a model. After signing in, open **Settings → Models**, add the **`github-copilot`** provider, and choose a model there.

## Upgrading from 0.4.x

Versions up to 0.4.5 registered their own `github-copilot-official` provider. That provider no longer exists. If your settings or sessions name it, switch them to the `github-copilot` provider — the model ids are the same. Your stored credential is adopted automatically; you do not need to sign in again.

## Configure

The plugin works with no configuration. The only setting is which credential
reference holds the GitHub OAuth token:

```yaml
- id: llm-github-copilot
  config:
    oauthTokenEnv: GITHUB_COPILOT_OAUTH_TOKEN   # credential reference / env var
```

Everything about models, endpoints, and request behaviour is configured on the
harness route under the `llm-pi-ai` settings section, not here.

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
This plugin registers no provider of its own — it publishes a credential for the harness's `github-copilot` provider. If no models appear, confirm you signed in (`/copilot-status`) and that the `github-copilot` provider is added under **Settings → Models**. Verify that your `cordis.patch.yml` uses `id: llm-github-copilot` and `name: '@lujianjun19/dsh-llm-github-copilot'`.

**Token expired**
No action needed. The plugin stores the long-lived GitHub OAuth token and refreshes the short-lived Copilot API token automatically before it expires. Only an explicit sign-out or token revocation requires a new `/copilot-login`.

## License

[MIT](LICENSE)