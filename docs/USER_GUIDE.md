# GitHub Copilot plugin — user guide

[Quick start](../README.md) · [中文](USER_GUIDE.zh.md)

## Compatibility

Supported Harness releases: `0.1.7-rc.1`–`0.1.7-rc.2`, `0.2.0-rc.1`–`0.2.0-rc.2`, `0.2.1-rc.2`–`0.2.1-rc.5`, and `0.2.2-rc.1`. Alpha releases are not supported; npm's moving dist-tags are not a support guarantee.

The [manifest](../package.json) declares DSH peers as `^0.1.7-rc.1 || ^0.2.0-rc.1 || ^0.2.1-rc.2 || ^0.2.2-rc.1` and Cordis as `^4.0.4`. The development baseline is Harness `0.2.2-rc.1` / Cordis `4.1.0`. See the [compatibility assessment](dsh-v0.2.1-rc.3-compatibility-analysis.md) for evidence and validation limits.

## Installation and updates

Commands target the `web` profile: `~/.dsh/profiles/web`, or `$DSH_HOME/profiles/web` when `DSH_HOME` is set. Use `dsh plugin` to keep its pnpm lockfile and bundle list in sync; do not mix in `npm install`.

Install from the repository's default branch (possibly unreleased):

```sh
dsh plugin --profile web add github:lujianjun19/dsh-llm-github-copilot -w
```

If pnpm requests build approval, copy the **exact key it reports** into `allowBuilds` in the profile's `pnpm-workspace.yaml`, then retry. Do not guess the key.

For an exact release or a package-manager rollback, replace `X.Y.Z`:

```sh
dsh plugin --profile web add @lujianjun19/dsh-llm-github-copilot@X.Y.Z -w
```

New releases can be delayed by pnpm's `minimumReleaseAge` policy. If necessary, allow only the intended package/version through `minimumReleaseAgeExclude` in that workspace file, then install by exact version. `@latest` may still select an older version.

Check the installed package:

```sh
dsh plugin --profile web list @lujianjun19/dsh-llm-github-copilot
```

The installer adds the bundle to `dsh.profile.bundles` and loads its `cordis.patch.yml`. Remove any old manual plugin `insert` rather than registering it twice. Restart DSH and hard-refresh the browser after updating.

## Credentials and configuration

- Device flow writes a grant at `llm-pi-ai/github-copilot` and a copy to the configured reference when writable. The route owns that grant's payload and performs token exchange, refresh, and account endpoint selection.
- A token from the configured reference/environment is adopted when the credentials service mounts, **only if no usable OAuth grant exists**. A grant takes precedence over the reference. Read-only references are not overwritten.
- Use a token from a compatible Copilot OAuth flow. The plugin does not validate token prefixes or guarantee Copilot access for an arbitrary PAT or `gh auth login` token.
- `/copilot-status` checks storage, not the GitHub API. It reports a model count only after the route records `availableModelIds`; it does not fetch or list models.
- Sign-out deletes the grant and writable reference. An environment/`.env` or external source can still supply a token: the API reports `credentialRemaining: true`, never the token itself. Remove that external token, restart, and run `/copilot-logout`; otherwise it can be adopted again on startup. GitHub authorization is not revoked.
- `oauthTokenEnv` is a Loader-owned live option in the active profile's `cordis.patch.yml`, not a `settings.yaml` section. Use the [README override](../README.md#optional-configuration), not another `insert`. Changing it does not move the grant or create another account. Models, endpoints, and request options belong under Harness's `llm-pi-ai` entry.

## Troubleshooting

### Signed in, but no Copilot models appear

Configure the built-in `github-copilot` provider under **Settings → Models**. Repeated sign-in does not add a provider. If the plugin page itself is missing, check the installed version and bundle registration, then restart DSH and hard-refresh.

### A model is missing, rejects requests, or remains visible after sign-out

The picker comes from the Harness route's catalog/configuration, not a live account entitlement check. Check the actual request error and account/organization model policies. Removing a credential does not remove provider configuration. This plugin cannot extend the catalog or diagnose every missing model as an IP restriction. See the [model-list tracking issue](issues/github-copilot-model-list-refresh.md).

### Network errors or a pending device code

Check access to GitHub. Device-flow requests honor `https_proxy`/`HTTPS_PROXY`/`http_proxy`/`HTTP_PROXY` with HTTP(S) proxy URLs, and hostname-based `no_proxy`/`NO_PROXY`. This is **not** the proxy configuration for the Harness route's model requests.

Polling retries transient failures until expiry. `/copilot-login` reuses a pending code; start again after expiry or denial. Closing the dialog does not cancel Host polling.

### Token exchange fails or a token was revoked

Short-lived Copilot tokens are refreshed by the Harness route. A revoked or unusable long-lived GitHub token needs a new sign-in: remove any external token source, sign out, then run `/copilot-login` again.

### Duplicate provider or an old adapter installation

For `configurable provider "github-copilot" is already declared`, check for duplicate provider configuration, obsolete adapter registrations, or a manual plugin `insert` alongside the bundle. Keep one bundle registration and configure the built-in provider once.

When upgrading from plugin `0.4.5` or earlier, replace `github-copilot-official` references in settings and sessions with `github-copilot` and choose a model from the current catalog. An existing valid token reference is adopted without a second sign-in.

## Development and local deployment

Work in the repository root, editing `src/host/` and `src/client/`, not generated `lib/` files. Follow the [branch, test, PR, and release workflow](WORKFLOW.md).

```sh
npm ci
npm run build
npm test
npm run check
npx playwright install chromium
npm run test:harness -- 0.2.2-rc.1
```

The Harness check uses a disposable `DSH_HOME`, packed installation, Chromium, and simulated GitHub responses. It neither uses your credentials nor makes a real Copilot inference request. The full version matrix and test options are in [WORKFLOW.md](WORKFLOW.md).

For an initial checkout installation, build first, then register the bundle:

```sh
dsh plugin --profile web add . -w
```

After all checks pass, optionally deploy to the local Web profile:

```sh
npm run deploy
```

Deploy builds, runs artifact tests, and atomically copies release files/runtime dependencies with a rollback backup. It does not run `npm install` or register a missing bundle. Restart DSH for Host changes; hard-refresh for Client changes.

### Rollback a local deploy

Deploy retains up to five backups under `${DSH_HOME:-$HOME/.dsh}/plugin-backups/dsh-llm-github-copilot/`, named by version and timestamp. Stop DSH and replace `<backup-directory>` before running:

```sh
PLUGIN="${DSH_HOME:-$HOME/.dsh}/profiles/web/node_modules/@lujianjun19/dsh-llm-github-copilot"
BACKUP="${DSH_HOME:-$HOME/.dsh}/plugin-backups/dsh-llm-github-copilot/<backup-directory>"
test -d "$BACKUP" && mv "$PLUGIN" "${PLUGIN}.before-rollback-$(date +%Y%m%d%H%M%S)" && cp -a "$BACKUP" "$PLUGIN"
dsh web
```

This restores package files, not the profile manifest or lockfile. For npm/GitHub-managed installations, use the exact-version install command above instead.
