# DeepSeek Harness `dsh-v0.1.7-rc.1` compatibility analysis

## Scope and evidence

This analysis compares this plugin at `0.4.6` with the released Harness tag
`dsh-v0.1.7-rc.1` (`46a7f68b0922371ce7144b668b90e377d8e799f4`) in the local
`~/repos/deepseek-harness` checkout. The tag is also published as
`@deepseek-ai/dsh@0.1.7-rc.1` on npm.

The review follows the plugin's actual boundary: it owns GitHub's device flow
and writes the `llm-pi-ai/github-copilot` credential record. It must not grow
back into an LLM adapter. See [ADR-0002](adr/0002-narrow-to-credential-provider.md).

> **Historical finding.** This report records the pre-migration `0.4.6` source
> state. The follow-on `fix/dsh-0.1.7-compatibility` change implements the
> listed peer-range and Settings migrations. A live-browser regression found
> afterward (documented below) required a further correction: the Web OAuth
> routes moved off `ctx.webServer.register()` (a raw, unauthenticated route
> unreachable through the browser's shared `/api` channel) onto
> `ctx.connection.fetch.register()`, the harness's actual mechanism for an
> authenticated browser-facing REST endpoint under `/api`. Retain this report
> as the evidence for why that migration, and its correction, were made.
>
> **Post-migration correction — the `/api` route mechanism.** The first pass of
> this migration only changed the *client's* fetch URL to `/api/<path>`,
> leaving the *Host* registered on `ctx.webServer` at the unprefixed `<path>`.
> `ctx.webServer.register()` and the shared `/api` channel are two entirely
> separate route tables — a request under `/api/*` is dispatched only through
> `ctx.connection`'s own `fetchRoutes` map (populated exclusively by
> `ctx.connection.fetch.register({ path: '/api/...', methods, requestBody,
> fetch })`, a Web-standard `Request -> Promise<Response>` handler) — so the
> mismatch surfaced as a live 404 on both `GET .../status` and `POST
> .../login` once a genuinely fresh Host process was tested end to end from a
> real browser. See `packages/client/connection/src/rpc-host.ts` in the
> Harness checkout for `createSharedFetchHandler()`, and
> `packages/api/session-controller/src/media-references.ts` /
> `packages/client/file-upload/src/index.ts` for other Harness plugins using
> the same registration idiom.

## Verdict

**An update is required before this plugin can claim support for DSH
`0.1.7-rc.1`.** There are two independent blockers:

1. **Every DSH prerelease peer range excludes `0.1.7-rc.1`.** SemVer does not
   treat `^0.1.5-rc.1` as accepting a later prerelease such as `0.1.7-rc.1`.
   The installed profile will therefore report unsatisfied peers (and can refuse
   installation when strict peer checking is enabled).
2. **The host plugin calls a Settings API which no longer exists.**
   `src/host/12-apply.js` calls `settings.installSection(...)`; the `0.1.7`
   Settings service removed that API in favour of Loader-owned volatile Config.
   In the normal Web composition, where `dsh-settings` is mounted, this scope
   will attempt to call an undefined method.

The credential handoff itself remains compatible, and the Web client APIs this
plugin calls have not been removed. This is consequently a focused
compatibility migration, not a reason to restore provider, model, request, or
streaming code.

## Findings

### 1. Peer ranges reject the target release — **blocking packaging issue**

`package.json` currently declares 13 DSH component peers as
`^0.1.5-rc.1`. A direct SemVer check against the target returned `false` for
all of them:

| Peer family | Current range | Target | Result |
| --- | --- | --- | --- |
| `dsh-api-remotes`, `dsh-api-session-controller` | `^0.1.5-rc.1` | `0.1.7-rc.1` | rejected |
| `dsh-client-*` (7 declared packages) | `^0.1.5-rc.1` | `0.1.7-rc.1` | rejected |
| `dsh-commands`, `dsh-credentials`, `dsh-launch-environment`, `dsh-settings` | `^0.1.5-rc.1` | `0.1.7-rc.1` | rejected |

This is normal prerelease SemVer behaviour, not merely an overly conservative
warning. `@deepseek-ai/cordis` is different: the current `^4.0.2` does accept
the target's bundled `4.0.4`.

**Required change:** update every DSH peer range and corresponding development
dependency to `^0.1.7-rc.1`; update the Cordis floor to `^4.0.4` as well if the
new release is the declared baseline. Keep `@deepseek-ai/dsh-llm` out of
runtime dependencies; its presence as a development-only test dependency does
not change the ADR boundary.

**Sources**

- This repository: [`package.json`](../package.json)
- Harness target manifests: `packages/{api,client,credentials,interaction,llm,settings,util}/*/package.json`
- Harness target Cordis manifest: `vendor/cordis/package.json` (`4.0.4`)

### 2. `settings.installSection()` was removed — **blocking runtime issue**

The plugin currently executes this old Settings integration in
`src/host/12-apply.js`:

```js
ctx.inject(["settings"], (settingsCtx) => {
  settingsCtx.settings.installSection(ctx, NS, Config, config, { /* … */ })
})
```

That API was present at the old compatibility floor, but it was removed by the
`0.1.7` Settings redesign. The target implementation exposes
`settings.configure({ auto: false }, ctx.fiber)` for a plugin that owns its own
settings page; mutable settings now belong to Loader configuration and must be
declared with Schemastery's `.volatile()`. The new Settings README explicitly
says that business plugins read their Config references directly and that the
old `settings.yaml` is imported only as a migration aid.

The default base bundle mounts `dsh-settings` whenever a profile context exists.
That is the normal `dsh web --profile web` case, so the old scoped callback is
not safely dormant. It will encounter an undefined `installSection` method.

**Required migration**

1. Make `oauthTokenEnv` volatile in `Config`, preserving its
   `credential-ref` role and default.
2. Read it from the Loader-held Config reference (for example,
   `config.oauthTokenEnv.get()`) wherever options are resolved; do not retain a
   mutable `setSource` callback.
3. Replace the old `installSection` registration with the target pattern:

   ```js
   ctx.inject(['settings'], child => {
     child.effect(() => child.settings.configure({ auto: false }, ctx.fiber))
   })
   ```

   `auto: false` is appropriate because this plugin supplies the dedicated
   GitHub Copilot page rather than a generated form.
4. If any behaviour must react immediately to a live profile edit, listen to
   `loader/volatile-update` or read the Config reference at action time. Do
   not reintroduce a separate Settings-owned state plane.
5. Update the user documentation: configuration is stored on the
   `llm-github-copilot` profile entry in `cordis.patch.yml` / the active profile
   patch, not in a continuously owned `settings.yaml` section.

The existing README configuration example already uses the correct entry id
(`llm-github-copilot`); its surrounding version/support text and settings
explanation still need review as part of the implementation.

**Sources**

- Plugin call site: [`src/host/12-apply.js`](../src/host/12-apply.js)
- Target service and migration guide:
  `packages/settings/settings/src/index.ts` and
  `packages/settings/settings/README.md`
- Target reference implementations:
  `packages/llm/llm-pi-ai/src/{config,index}.ts` and
  `packages/llm/llm-deepseek/src/{config,index}.ts`
- Target default composition:
  `packages/bundle/base/cordis.patch.yml`

### 3. The credential record contract remains valid — **no code change indicated**

The plugin writes:

```js
{
  kind: 'grant',
  payload: { type: 'oauth', refresh: token, access: '', expires: 0 }
}
```

at `credentialKey('llm-pi-ai', 'github-copilot')`. In target source,
`dsh-llm-pi-ai` still uses `RECORD_SCOPE = 'llm-pi-ai'`, derives the same key
with `recordKeyFor(providerId)`, and deliberately passes a `grant` payload
through to pi-ai as opaque JSON. Its `credentialStoreFrom()` reads and writes
that exact record address. Nothing in the `0.1.5-rc.1 → 0.1.7-rc.1` diff changes
this storage adapter or its record shape.

The plugin's existing read-back check in `storeRawOAuthToken()` remains an
important defence: it will fail loudly if a future consuming route stops
preserving `payload.refresh`. Keep it.

**Sources**

- Plugin contract and tests:
  [`src/host/10-config-resolution.js`](../src/host/10-config-resolution.js),
  [`tests/credential-handoff.test.mjs`](../tests/credential-handoff.test.mjs)
- Target consumer:
  `packages/llm/llm-pi-ai/src/auth.ts`

### 4. The forwarded credential event and client primitives remain available — **compatible, but regression-test**

The client relies on:

- `ctx.remote.$on('credentials/reference-updated', ...)` to close the device
  dialog after the token reference commits;
- `ctx.sessions.binding(sessionId)` for the logout confirmation;
- `ctx.slots.inject/register`, `ctx.commandUi.decorate`, and `ctx.locale`.

The target remote-event allow-list still includes
`credentials/reference-updated`; target `ClientSessions` still exposes
`binding(id)`; and the slots API still has the `inject()` and `register()`
operations used here. The target release makes broad UI and session changes,
so this is not a claim of full UI test coverage, but there is no identified
removed symbol on this plugin's direct path.

**Sources**

- Plugin client integration: [`src/client/10-apply.js`](../src/client/10-apply.js)
- Target event list: `packages/api/remotes/src/remote-events.ts`
- Target sessions contract: `packages/api/session-controller/src/client/contract/sessions.ts`
- Target slots registry: `packages/client/ui-renderer/src/client/registry.ts`

### 5. Authorization is now mounted, but it does not make this plugin redundant — **important distinction**

`0.1.7` newly mounts `@deepseek-ai/dsh-authorization` in the default base
bundle. `dsh-llm-pi-ai` consequently registers an authorization flow for every
catalog provider, including `github-copilot`, using the same credential key.
The plugin must **not** register another flow for that key: the authorization
service correctly rejects duplicates with `DUPLICATE_FLOW`.

However, a whole-tree source search at the target tag finds no generic
Web/remote controller that starts a pi-ai authorization flow. The only target
caller of `authorization.begin()` is the specialised DeepSeek-account provider,
not a Copilot UI. `dsh-llm-pi-ai` registers flows but does not expose a surface
that starts them. Therefore the new host service is infrastructure for a future
native sign-in surface; it does not replace the plugin's current device-flow
page, commands, and Web endpoints.

The current plugin already avoids the duplicate-flow problem because it writes
its credential directly and does **not** call `ctx.authorization.registerFlow()`.
That design should remain unchanged.

**Sources**

- Target base bundle: `packages/bundle/base/cordis.patch.yml`
- Target pi-ai flow registration:
  `packages/llm/llm-pi-ai/src/{index,login,auth}.ts`
- Target duplicate protection: `packages/credentials/authorization/src/index.ts`
- Target generic authorization call-site search: all `packages/**/*.ts(x)` at
  `dsh-v0.1.7-rc.1`; only `deepseek-account-platform` starts the service.

## Recommended implementation plan

1. Create a compatibility branch and update package peer/dev dependency ranges
   for `0.1.7-rc.1` (including Cordis `4.0.4`).
2. Migrate the one-field host configuration to volatile Config and the
   `settings.configure({ auto: false }, ctx.fiber)` pattern. Remove only the
   obsolete `installSection` plumbing; retain the credential reference feature.
3. Preserve the exact credential record helpers and their read-back validation.
   Add a target-version regression assertion for the record written by a device
   login if the test harness can exercise a real credential service.
4. Add a host composition regression test with `dsh-settings` mounted. It must
   prove that plugin activation has no `installSection` failure and that a live
   `oauthTokenEnv` edit is observed.
5. Run the existing browser client tests against `0.1.7-rc.1` and add an
   integration smoke: open the Copilot page, start device flow, commit the
   credential reference, and verify the dialog closes on
   `credentials/reference-updated`.
6. Update both READMEs, `AGENTS.md`, and the compatibility note in
   `CHANGELOG.md` in the same PR. Do not release until the normal build, test,
   check, and profile-install smoke have passed.

## Non-goals

- Do not add `@deepseek-ai/dsh-llm` as a runtime dependency.
- Do not register an LLM adapter, a model catalogue, request serializers,
  streaming, or image handling in this plugin.
- Do not register a second native authorization flow. Reassess retirement only
  after a shipped generic authorization client can actually start the
  `github-copilot` flow.
