# dsh-llm-github-copilot

English | [中文](README.zh.md)

GitHub Copilot sign-in for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness): a device-flow login page and chat commands. This plugin **only supplies credentials**; the Harness's built-in `github-copilot` route owns models, token refresh, images, and requests.

## Requirements

- Harness `0.2.2-rc.1` (current development baseline); [older supported releases and compatibility details](docs/USER_GUIDE.md#compatibility).
- A GitHub account with Copilot access; Node.js ≥ 24 and pnpm ≥ 9 on `PATH`.
- The default Web profile, or a custom composition with `@deepseek-ai/dsh-llm-pi-ai` and `dsh-credentials-local`.

## Install or update

Install from npm:

```sh
dsh plugin --profile web add @lujianjun19/dsh-llm-github-copilot -w
```

Update an existing installation:

```sh
dsh plugin --profile web update @lujianjun19/dsh-llm-github-copilot --latest -w
```

Restart `dsh web` and hard-refresh the browser. Confirm the version at the bottom of **Settings → GitHub Copilot**. The bundle is registered automatically; do not add a second plugin `insert` to the profile patch.

For [GitHub source installs, exact versions, or delayed updates](docs/USER_GUIDE.md#installation-and-updates), see the guide.

## Sign in and use a model

1. Open **Settings → GitHub Copilot → Sign in**.
2. Open the displayed GitHub URL, enter the device code, and authorize the GitHub App (VS Code). The plugin saves the token automatically.
3. In **Settings → Models**, add the built-in **`github-copilot`** provider if absent. No custom endpoint or pasted API key is needed.
4. Save, choose a model in the chat model selector, and send a request.

**Signing in does not add the provider configuration.** A visible model is not proof of account access; availability depends on the Harness catalog and your account/organization policies.

Chat commands are also available:

| Command | Purpose |
| --- | --- |
| `/copilot-login` | Start sign-in |
| `/copilot-status` | Check whether a token is stored, not whether a live request succeeds |
| `/copilot-logout` | Remove the local grant and writable token reference |

Sign-out does not revoke GitHub authorization or remove model configuration. If an external token remains, the UI reports it; remove that token from the environment/`.env` or external source, restart DSH, and sign out again.

## Optional configuration

No configuration is needed for device-flow sign-in. To use an existing compatible **long-lived GitHub OAuth token** instead:

```sh
export GITHUB_COPILOT_OAUTH_TOKEN='<your-github-oauth-token>'
dsh web
```

An existing grant takes precedence. Do not assume an arbitrary PAT has Copilot access; short-lived Copilot API tokens are not suitable here.

The only plugin option, `oauthTokenEnv`, changes the credential reference name. Override the installed entry in the active profile's `cordis.patch.yml`:

```yaml
- id: llm-github-copilot
  config:
    oauthTokenEnv: GITHUB_COPILOT_OAUTH_TOKEN
```

The consuming grant remains at `llm-pi-ai/github-copilot`; this option does not create another account/provider. [Credential details](docs/USER_GUIDE.md#credentials-and-configuration).

## More

- [Troubleshooting, proxies, and old-version migration](docs/USER_GUIDE.md#troubleshooting)
- [Development, local deployment, and rollback](docs/USER_GUIDE.md#development-and-local-deployment)
- [Development and release workflow](docs/WORKFLOW.md)
- [Why this plugin is credential-only](docs/adr/0002-narrow-to-credential-provider.md) · [Changelog](CHANGELOG.md) · [MIT license](LICENSE)
