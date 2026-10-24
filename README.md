# dsh-llm-github-copilot

English | [中文](README.zh.md)

GitHub Copilot sign-in for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness).

This plugin provides a GitHub OAuth device-flow page and slash commands, then writes the credential used by the Harness's built-in `github-copilot` provider. It registers **no LLM adapter** and owns no model catalog: token exchange and refresh, model availability, requests, images, and streaming belong to the Harness's `@deepseek-ai/dsh-llm-pi-ai` route. Available models depend on that route's catalog and your account's access, not just your Copilot plan. See [ADR-0002](docs/adr/0002-narrow-to-credential-provider.md).

## Requirements

- **Supported Harness releases:** `0.1.7-rc.1` through `0.1.7-rc.2`, `0.2.0-rc.1` through `0.2.0-rc.2`, and `0.2.1-rc.2` through `0.2.1-rc.3`, with `@deepseek-ai/cordis` `^4.0.4`. The development baseline is `0.2.1-rc.3`.
- **Declared Harness peer range:** `^0.1.7-rc.1 || ^0.2.0-rc.1 || ^0.2.1-rc.2` (see [`package.json`](package.json)). npm's moving `latest`/`next` tags are not a support guarantee. See the [0.2.1 compatibility assessment](docs/dsh-v0.2.1-rc.3-compatibility-analysis.md) for validation scope.
- The Harness's bundled `@deepseek-ai/dsh-llm-pi-ai` route and a credentials service such as `dsh-credentials-local`. The default Web profile supplies these; custom compositions must mount them.
- A GitHub account with access to Copilot.
- Node.js ≥ 24; pnpm ≥ 9 on `PATH` for `dsh plugin` commands.

## Install

The commands below target the `web` profile. Its default directory is `~/.dsh/profiles/web`; if `DSH_HOME` is set, it is `$DSH_HOME/profiles/web`.

### From npm (recommended)

```sh
dsh plugin --profile web add @lujianjun19/dsh-llm-github-copilot -w
```

### From GitHub

```sh
dsh plugin --profile web add github:lujianjun19/dsh-llm-github-copilot -w
```

This installs the repository's default branch, which may contain unreleased changes. If pnpm asks for build approval, copy the **exact key it reports** into `allowBuilds` in the profile's `pnpm-workspace.yaml`, then repeat the command. Do not guess the key from the repository name.

`dsh plugin` registers this package in the profile's `dsh.profile.bundles` and loads its bundled `cordis.patch.yml`. **Do not add another `insert` entry for this plugin to the profile patch.** If an older installation has a manual registration, remove that duplicate when using the bundle installation.

Stop any running instance, then start the profile again:

```sh
dsh web
```

Hard-refresh an already open browser tab after updating the plugin's client bundle.

## Update

Use the Harness package manager so the profile's pnpm lockfile and bundle list stay in sync:

```sh
dsh plugin --profile web update @lujianjun19/dsh-llm-github-copilot --latest -w
```

For a specific release, replace `X.Y.Z` with its version:

```sh
dsh plugin --profile web add @lujianjun19/dsh-llm-github-copilot@X.Y.Z -w
```

A profile's pnpm `minimumReleaseAge` policy can delay newly published versions. If the installed version is older than expected, check that policy and, if appropriate, allow only the intended package/version through `minimumReleaseAgeExclude`, then install the exact version. Do not assume `@latest` selected the release you wanted, or mix `npm install` into a pnpm-managed profile.

Restart DSH and hard-refresh the browser. Confirm the installed version at the bottom of **Settings → GitHub Copilot**, or run:

```sh
dsh plugin --profile web list @lujianjun19/dsh-llm-github-copilot
```

## Sign in

Open **Settings → GitHub Copilot** and choose **Sign in**, or run this in a Harness chat:

```text
/copilot-login
```

Open the displayed GitHub verification URL, enter the device code, and authorize the GitHub App (VS Code). Polling continues on the Host and stores the credential automatically after authorization. The Web sign-in UI updates automatically; the chat-command dialog closes when sign-in is detected.

Check the stored credential state with:

```text
/copilot-status
```

`authenticated` means a long-lived token is present, **not** that a live API request succeeded. The command reports a model **count** only if the downstream route has recorded `availableModelIds`; it does not fetch or list models. Before the route's first token exchange, that count may be absent.

To remove the local credential:

```text
/copilot-logout
```

The Web UI asks for confirmation. Sign-out deletes the grant and any writable token reference; it does not revoke the GitHub authorization or remove the configured model provider. If a read-only reference or environment/`.env` fallback still supplies a token, the UI and commands explicitly report that sign-out is incomplete and tell you to remove the external token and restart. The status API exposes `credentialRemaining: true` in this case and never returns the token itself.

### Use an existing OAuth token

You can supply a long-lived GitHub OAuth token instead of using the device flow:

```sh
export GITHUB_COPILOT_OAUTH_TOKEN='<your-github-oauth-token>'
dsh web
```

When the credentials service becomes available, the plugin adopts that token into the grant **only if no grant already exists**. An existing grant takes precedence over the environment/reference. On Harness versions where the environment-supplied reference is read-only, adoption writes the grant without attempting to overwrite the environment.

Use a token from a compatible Copilot OAuth flow, not a short-lived Copilot API token. This plugin does not validate token prefixes or guarantee that an arbitrary PAT or `gh auth login` token has Copilot access.

To sign out of an environment-token setup, remove the variable from the launching environment, restart DSH without it, then run `/copilot-logout`. Otherwise older Harness versions reject clearing the read-only reference; newer versions can clear the file override but still resolve the environment token. It may be adopted again on a later start.

## Selecting a model

Signing in publishes a credential; it does **not** add a provider configuration.

1. Open **Settings → Models**, separate from this plugin's sign-in page.
2. If it is not already configured, choose **Add provider** and select the built-in **`github-copilot`** entry. No custom endpoint or pasted API key is needed for the stored grant.
3. Save, then reopen the chat input's model selector and choose a model under `github-copilot`.
4. Send a request. The Harness route exchanges the long-lived GitHub token for a short-lived Copilot token as needed, refreshes it, and derives the account's endpoint.

On the verified Harness baseline, the picker comes from the route's configured catalog. Opening it is **not** proof of an account-specific model discovery or successful authentication, and sign-out may leave catalog entries visible. The plugin neither filters those entries nor adds models absent from the downstream catalog. See the [model-list tracking issue](docs/issues/github-copilot-model-list-refresh.md).

If upgrading from an old adapter-based installation (through `0.4.5`), replace references to the removed `github-copilot-official` provider in settings and sessions with `github-copilot`, selecting a model available in the current catalog. An existing token reference is adopted automatically; no second sign-in is needed if that token is still valid.

## Configure

The plugin works without configuration. Its only option is `oauthTokenEnv`, the credential reference/environment variable used to read an existing token and, when writable, store a copy after sign-in:

```yaml
- id: llm-github-copilot
  config:
    oauthTokenEnv: GITHUB_COPILOT_OAUTH_TOKEN
```

Put this **override**, not another `insert`, in the active profile's `cordis.patch.yml`. Live settings use that profile patch, not a separate `settings.yaml` section.

The grant the route actually consumes always lives at `llm-pi-ai/github-copilot`; changing `oauthTokenEnv` does not move it or create a second account/provider. Models, endpoints, and request behaviour are configured under the Harness route's `llm-pi-ai` entry, not here.

## Develop

Requires Node.js ≥ 24 and npm. Work in the repository root; edit `src/host/` and `src/client/`, not generated `lib/` files.

```sh
npm ci
npm run build      # concatenate source fragments → lib/index.js and lib/client.js
npm test           # test generated artifacts, credential handoff, i18n, metadata, and README contracts
npm run check      # build + artifact tests + npm pack dry-run (prepack runs the full test suite)
```

For packed-installation and real-browser checks against the supported release candidates:

```sh
npx playwright install chromium
npm run test:harness -- 0.2.1-rc.2
npm run test:harness -- 0.2.1-rc.3
```

These checks use a disposable `DSH_HOME` and simulated GitHub responses, not your credentials or a real Copilot request. CI also covers `0.2.0-rc.2`. See [the development workflow](docs/WORKFLOW.md) for test options and branch, PR, and release rules.

After all checks pass, optionally deploy into the local Web profile:

```sh
npm run deploy     # build → artifact tests → atomic deploy with rollback backup
```

This copies the release files and runtime dependencies without running `npm install`; it does not register a missing bundle in the profile. For an initial checkout installation, build first and use:

```sh
dsh plugin --profile web add . -w
```

After Host changes restart DSH; after Client-only changes a hard refresh (`Ctrl+Shift+R`) is usually enough.

## Rollback a local deploy

`npm run deploy` backs up an existing installation under `${DSH_HOME:-$HOME/.dsh}/plugin-backups/dsh-llm-github-copilot/` and keeps up to five backup directories. Directory names include the version and timestamp.

Stop DSH, choose a backup, then replace the installed directory rather than copying into an existing one:

```sh
PLUGIN="${DSH_HOME:-$HOME/.dsh}/profiles/web/node_modules/@lujianjun19/dsh-llm-github-copilot"
BACKUP="${DSH_HOME:-$HOME/.dsh}/plugin-backups/dsh-llm-github-copilot/<backup-directory>"
# Replace <backup-directory> above before running these commands.
test -d "$BACKUP" && mv "$PLUGIN" "${PLUGIN}.before-rollback-$(date +%Y%m%d%H%M%S)" && cp -a "$BACKUP" "$PLUGIN"
dsh web
```

This restores a local deploy's package files, not the profile manifest or lockfile. For an npm/GitHub-managed installation, install the desired release with `dsh plugin --profile web add …@X.Y.Z -w` instead.

## Troubleshooting

### Signed in, but no GitHub Copilot models appear

Confirm `github-copilot` is configured under **Settings → Models** (see [Selecting a model](#selecting-a-model)). If the settings page itself is missing, check the installed version and bundle registration, then restart DSH and hard-refresh. Repeated sign-in does not add a provider.

### A model is missing, or a visible model rejects requests

Check the Harness route's catalog/configuration, your account and organization model policies, and the actual request error. The picker is not a live entitlement check. This plugin cannot extend the catalog or diagnose every missing model as an IP restriction.

### `/copilot-login` reports a network error or stays pending

Check access to GitHub. Device-flow requests honor `https_proxy`/`HTTPS_PROXY`/`http_proxy`/`HTTP_PROXY` (HTTP(S) proxy URLs) and hostname-based `no_proxy`/`NO_PROXY`. This transport applies only to this plugin's device flow, not the Harness route's model requests. Polling retries transient failures until the device code expires. While a flow is pending, `/copilot-login` reuses the same code; after expiry or denial, start sign-in again. Closing the dialog does not cancel Host polling.

### Token exchange fails, or a token was revoked

`/copilot-status` only checks that a token is stored. Short-lived Copilot token refresh is the Harness route's responsibility; a revoked or unusable long-lived GitHub token needs a new sign-in. Remove any ambient token as described above, sign out, then run `/copilot-login` again.

### `configurable provider "github-copilot" is already declared`

This plugin registers no model provider. Check for duplicate provider configuration, obsolete adapter registrations, or a manual plugin `insert` left alongside the bundle. Keep one plugin bundle registration and configure the built-in provider once.

### Models remain in the picker after sign-out

Removing the credential does not remove the provider configuration. Catalog visibility and credential-based filtering belong to the Harness route; see the [tracking issue](docs/issues/github-copilot-model-list-refresh.md).

## License

[MIT](LICENSE)
