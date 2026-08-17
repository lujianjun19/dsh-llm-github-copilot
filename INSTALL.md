# Installation Guide — `dsh-llm-github-copilot`

English | [中文](INSTALL.zh.md)

This plugin adds the `github-copilot-official` provider to DeepSeek Harness: GitHub OAuth device-flow sign-in, automatic Copilot API token exchange (with caching and pre-expiry refresh), and live model discovery via the OpenAI-compatible chat-completions interface.

---

## Prerequisites

- DeepSeek Harness installed; `dsh` command available.
- Node.js ≥ 24.
- A GitHub account with an active [GitHub Copilot](https://github.com/features/copilot) subscription (Individual, Business, or Enterprise).

---

## 1. Install

### Recommended — `dsh plugin` (one command)

```sh
dsh plugin --profile web add github:lujianjun19/dsh-llm-github-copilot
```

pnpm 10 and newer block git dependency build scripts by default. If the command asks you to approve the build, add the package key it reports to the profile's `pnpm-workspace.yaml`:

```yaml
allowBuilds:
  dsh-llm-github-copilot: true
```

Then repeat the install command.

### Alternative — manual copy

```bash
mkdir -p ~/.dsh/profiles/web/node_modules/@deepseek-ai
cp -r ./dsh-llm-github-copilot \
      ~/.dsh/profiles/web/node_modules/@deepseek-ai/dsh-llm-github-copilot
```

> Use a real directory copy, not a symlink. Node resolves peer dependencies by walking parent directories; a symlink would redirect resolution to the original source location where DSH's own packages are not present.

### Alternative — local tarball

```bash
dsh plugin --profile web add /path/to/dsh-llm-github-copilot-*.tgz
```

---

## 2. Register the plugin

Edit `~/.dsh/profiles/web/cordis.patch.yml` and add:

```yaml
- insert:
    - id: llm-github-copilot
      name: '@deepseek-ai/dsh-llm-github-copilot'
```

If the file currently contains an empty array `[]`, replace the whole file with the block above.

---

## 3. Restart DSH

Adding a new plugin package requires a full restart. HMR is reliable for configuration changes to already-loaded plugins but not for loading a brand-new package into a running process.

```bash
# Stop the running dsh web (Ctrl+C), then:
dsh web
```

### Proxy note (important for Claude and full model catalog)

GitHub selects the model catalog based on your egress IP. From a restricted-region IP you may receive only ~32 models with no Claude. The plugin reads the standard proxy environment variables automatically (`HTTPS_PROXY`, `https_proxy`, `HTTP_PROXY`, `NO_PROXY`), so exporting a proxy before starting DSH is sufficient:

```bash
export HTTPS_PROXY=http://127.0.0.1:7890
dsh web
```

No extra flags are needed. If you prefer using Node's built-in proxy support instead:

```bash
NODE_USE_ENV_PROXY=1 dsh web
```

---

## 4. Sign in

Run the login command in the Harness chat input:

```
/copilot-login
```

Follow the instructions:

1. Open the verification URL in your browser (`https://github.com/login/device`).
2. Enter the displayed code (format: `XXXX-XXXX`).
3. Authorize the GitHub App (shown as **VS Code**) and complete sign-in.

The plugin polls in the background, exchanges the device token for a Copilot API token, and stores it automatically. You do not need to copy or paste any token. Run `/copilot-status` afterwards to confirm authentication and see the model list.

### Alternative — environment variable

Set the token before starting DSH:

```bash
export GITHUB_COPILOT_OAUTH_TOKEN=<your-github-oauth-token>
dsh web
```

Or write it to the credentials file (`~/.dsh/.credentials.yaml`, mode 0600):

```yaml
GITHUB_COPILOT_OAUTH_TOKEN: "<your-github-oauth-token>"
```

**Supported token types:**

| Prefix | Source |
|--------|--------|
| `gho_` | OAuth token (`gh auth login`) |
| `github_pat_` | Fine-grained PAT (requires **Copilot** permission) |
| `ghu_` | GitHub App user token (VS Code client) |

`ghp_` classic PATs are not accepted by the Copilot API.

---

## 5. Verify

- `/copilot-status` should report **authenticated** and list the available models.
- The model selector in a conversation should show a **GitHub Copilot** group.

---

## Configuration

The plugin works without any configuration. To override defaults, add a section to `~/.dsh/settings.yaml`:

```yaml
llm-github-copilot:
  defaultContextWindow: 262144
```

All available fields:

| Field | Default | Description |
|-------|---------|-------------|
| `oauthTokenEnv` | `GITHUB_COPILOT_OAUTH_TOKEN` | Credential reference (rarely changed) |
| `baseURL` | auto | Override the Copilot API host. Defaults to the value returned by token exchange; falls back to `https://api.githubcopilot.com`. Business/Enterprise accounts have their own hosts — do not hard-code the personal host. |
| `models` | `[]` (live discovery) | Static fallback model list with `id`, `name`, `contextWindow`, `maxTokens` |
| `defaultContextWindow` | `262144` | Context window used when a model does not declare one |
| `defaultMaxTokens` | `32768` | Output cap used when a model does not declare one |
| `streamIdleTimeoutMs` | `300000` | Idle timeout for streaming responses |
| `retryPolicy` | standard | Retry policy |

---

## Troubleshooting

**Model selector shows no GitHub Copilot group after restart**
The plugin loaded in a previous process that didn't pick up the new package. Restart `dsh web`. The stored token is preserved; no need to sign in again.

**Models appear but Claude is missing**
Your egress IP is restricted. Export `HTTPS_PROXY` pointing to a proxy that exits from an unrestricted region, then restart.

**`/copilot-login` times out or reports a network error**
Transient network issue during device-code polling. Run `/copilot-login` again to get a fresh code (the old one is invalidated automatically).

**`configurable provider "github-copilot" is already declared`**
An older version of this plugin used the route name `github-copilot`, which conflicts with a DSH built-in. This version uses `github-copilot-official`. Verify that your `cordis.patch.yml` uses `id: llm-github-copilot` and `name: '@deepseek-ai/dsh-llm-github-copilot'`.

**Token expired**
No action needed. The plugin stores the long-lived GitHub OAuth token and refreshes the short-lived Copilot API token automatically before it expires. Only an explicit sign-out or token revocation requires a new `/copilot-login`.

---

## Sign out

```
/copilot-logout
```

This removes the stored GitHub OAuth token. The model list will become empty until you sign in again.
