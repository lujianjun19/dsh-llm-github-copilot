# Repository instructions

## Development workflow

The complete development workflow is documented as a Mermaid diagram:

```text
docs/WORKFLOW.md
```

Read it to understand the full cycle: edit → local deploy → commit → release
→ CI publish → post-release install test. The sections below elaborate each
phase with exact commands.

## Source of truth

- Work only in this repository's root directory.
- Never edit `lib/index.js`, `lib/client.js`, or the installed package under `~/.dsh/profiles` directly.
- Host source lives in ordered fragments under `src/host/`.
- Browser source lives in ordered fragments under `src/client/`.
- Keep each fragment below 450 lines; split by responsibility before it exceeds the limit.

## Feature design authority

Before implementing vision or document capabilities, read:

```text
docs/VISION_AND_DOCUMENT_HANDOFF.zh-CN.md
```

Do not expand that scope (especially generic composer file upload or DSH core changes) without explicit user approval.

## DeepSeek Harness version dependency

- This plugin supports **`@deepseek-ai/dsh` `0.1.1-rc.2` and `0.1.2-alpha.1`**
  (`^0.1.1-rc.2 || 0.1.2-alpha.1` for the matching `@deepseek-ai/dsh-*`
  packages), with `@deepseek-ai/cordis` `^4.0.1`. See `peerDependencies` in
  `package.json`.
- `0.1.2-alpha.1` made three breaking `@deepseek-ai/dsh-llm` changes: `CallId`
  → `ToolCallId`, `requestImageHandleText(version)` → `(ref, version, access?)`,
  and a now-required `policy.placeholder(ref)` on
  `offloadRequestImagesWithPolicy`. **Every API whose shape differs between
  supported versions must go through `llmCompat()` in
  `src/host/01-llm-compat.js`.** Never bind a version-specific symbol with a
  static named import: a missing export fails ESM linking and takes down the
  entire plugin tree at boot, before any code runs.
- It also split the client packages: `@deepseek-ai/dsh-client-runtime` is gone
  in `0.1.2-alpha.1`, where `slots` comes from `@deepseek-ai/dsh-client-ui-renderer`
  and `sessions` from `@deepseek-ai/dsh-api-session-controller`. `dsh.client.inject`
  lists all three; both loaders skip inject entries absent from the graph.
- The vision path depends on APIs introduced in `0.1.1-rc.2`:
  `AttachmentStore.readImageRequest()`, and `offloadRequestImagesWithPolicy` /
  `requestImageHandleText` from `@deepseek-ai/dsh-llm`. Earlier releases
  (`0.1.0-rc.x`) lack these and will not run the current adapter.
- Do not lower the baseline below `0.1.1-rc.2`, and do not drop `0.1.2-alpha.1`,
  without an explicit, user-approved compatibility change.

## Required workflow

Before editing:

```bash
git status --short
```

### Always work on a new branch

**Never commit directly to `main`.** Create a branch for the change before the
first commit, and land it through a PR:

```bash
git checkout -b fix/<name>     # or feat/<name>, docs/<name>, refactor/<name>
```

This holds for documentation-only changes too. If you notice you have already
committed to `main`, recover before pushing:

```bash
git checkout -b fix/<name>     # carries the commits
git checkout main && git reset --hard origin/main
git checkout fix/<name>
```

One branch carries one coherent change, **including its documentation updates**.
Do not merge the code PR and then follow up with a separate docs PR — between
those two merges `main` documents behaviour it does not have.

### After editing

```bash
npm run build
npm test
npm run check
git diff --stat
git diff
```

### Documentation sync check — required before every commit

Code and docs drift silently: nothing fails when a document keeps describing a
version, signature, or constraint that the change just invalidated, and the
next agent reads that stale text as authority. Before committing, grep the
facts you changed across **every** document and update whatever no longer holds:

```bash
# Replace the pattern with the facts this change actually altered:
# version numbers, API signatures, exported names, event names, limits, defaults
rg -n '<changed-fact>' README.md README.zh.md AGENTS.md CONTEXT.md \
  CHANGELOG.md docs/ --glob '!node_modules'
```

Walk this list explicitly — each file owns different claims:

| Document | Owns | Update when |
| --- | --- | --- |
| `README.md` / `README.zh.md` | User-facing requirements, install, config | Supported versions, options, commands, or behaviour change. Both languages, always together. |
| `AGENTS.md` | Agent contract, workflow, version dependency | Rules, supported versions, required patterns, or release steps change. |
| `CONTEXT.md` | Domain vocabulary | A concept is introduced, renamed, or its boundary moves. |
| `docs/WORKFLOW.md` | The development-cycle diagram | Any step in the edit → release cycle changes. |
| `docs/VISION_AND_DOCUMENT_HANDOFF.zh-CN.md` | Vision design authority | A vision API, signature, limit, or policy it documents changes. Cited as authority — stale signatures here actively mislead. |
| `docs/adr/` | Accepted decisions | A decision is superseded — add a new ADR, do not silently rewrite an old one. |
| `CHANGELOG.md` | Released history | At release time (see “Releases”). |

When a document is a point-in-time record (a handoff spec, an ADR), add a
scoped note rather than rewriting history.

### Commit and deploy

Commit source and generated `lib/` artifacts together. Use Conventional Commit-style messages.

Deploy only after tests pass:

```bash
npm run deploy
```

The deploy command creates a rollback backup and atomically replaces the profile package. Restart `dsh web` after Host changes; hard-refresh the browser after Client changes.

## Dependency management

`scripts/deploy.mjs` does **not** run `npm install` — it copies files directly.
Runtime `dependencies` must therefore be kept in sync in two places:

1. Add the package to `dependencies` in `package.json` and run `npm install`.
2. Add the same name to the `bundledDeps` array in `scripts/deploy.mjs`.

`deploy.mjs` copies each entry from local `node_modules/` into the staged
plugin directory. Both `npm publish` (npm installs deps automatically from
`dependencies`) and `github:` source installs (pnpm installs deps into the
profile's hoisted `node_modules/`) resolve deps without needing them bundled
in the tarball — so **no `bundledDependencies` field is used**.
`peerDependencies` and `devDependencies` are excluded from `bundledDeps`.

## Release file checklist

Every file that must be present in the installed plugin must appear in **both**:

- `files` array in `package.json` (controls `npm publish` tarball)
- `releaseEntries` array in `scripts/deploy.mjs` (controls local deploy)

Currently required entries: `cordis.patch.yml`, `lib/index.js`, `lib/client.js`,
`package.json`, `README.md`, `README.zh.md`, `CHANGELOG.md`, `AGENTS.md`,
`LICENSE`, `docs/**`.

> `cordis.patch.yml` is mandatory: DSH loads this package as a bundle and
> reads `dsh.bundle.patch` at boot time. A missing file causes `ENOENT` on start.

## GitHub authentication

This repository has no stored SSH key or long-lived token. Use the global
`github-auth` Pi skill to obtain a session-scoped OAuth token:

```bash
# Get (or reuse cached) token
TOKEN=$(python3 ~/.pi/agent/skills/github-auth/scripts/get_token.py)

# Push commits
REPO=$(git remote get-url origin | sed 's|https://github.com/||')
git push "https://${TOKEN}@github.com/${REPO}" main

# Push a tag
git push "https://${TOKEN}@github.com/${REPO}" v0.x.y
```

The token is cached in `/tmp/.pi_github_token` for the OS session.
Do not echo or log the token value.

## Releases

- Update `CHANGELOG.md` before a release.
- Use SemVer with `npm version patch|minor|major`.
- Build a local release artifact with `npm run pack:local`.
- Do not reuse a released version for changed runtime code.
- Pushing a `v*` tag triggers the GitHub Actions Release workflow, which
  publishes to npm via OIDC Trusted Publishing (no `NPM_TOKEN` needed)
  and creates a GitHub Release automatically.

## Post-release installation test

After every tag push, verify both install sources before declaring the release
done. Run the steps below in order.

### 0. Wait for CI to publish

```bash
TOKEN=$(python3 ~/.pi/agent/skills/github-auth/scripts/get_token.py)
curl -s -H "Authorization: Bearer $TOKEN" \
  "https://api.github.com/repos/lujianjun19/dsh-llm-github-copilot/actions/runs?per_page=3" \
  | python3 -c "
import sys,json
for r in json.load(sys.stdin).get('workflow_runs',[]):
    print(r['name'], '|', r['status'], '|', r['conclusion'] or '-', '|', r['head_branch'] or '')
"
```

Wait until the `Release` workflow shows `completed | success` for the new tag.

### 1. Helper — clean the profile slot

Run this before each source test to start from a clean state:

```bash
cd ~/.dsh/profiles/web
python3 -c "
import json
p = json.load(open('package.json'))
p['dependencies'] = {k:v for k,v in p['dependencies'].items() if 'lujianjun' not in k}
p['dsh']['profile']['bundles'] = [b for b in p['dsh']['profile']['bundles'] if 'lujianjun' not in b]
open('package.json','w').write(json.dumps(p, indent=2)+'\n')
"
rm -rf node_modules/@lujianjun19
```

### 2. Test — install from npmjs

```bash
dsh plugin --profile web add @lujianjun19/dsh-llm-github-copilot
```

### 3. Test — install from GitHub source

```bash
dsh plugin --profile web add github:lujianjun19/dsh-llm-github-copilot -w
```

The `-w` flag and `allowBuilds` entry in `pnpm-workspace.yaml` are required;
both were added when the plugin was first registered and persist across installs.

### 4. Verify each install

After each install, confirm all of the following:

```bash
PLUGIN=~/.dsh/profiles/web/node_modules/@lujianjun19/dsh-llm-github-copilot

node -e "console.log('version:', require('$PLUGIN/package.json').version)"

# cordis.patch.yml present
cat $PLUGIN/cordis.patch.yml

# client module id matches package name
grep '^  id:' $PLUGIN/lib/client.js

# runtime deps resolvable
node --input-type=module << 'EOF'
import { createRequire } from 'module'
const req = createRequire(process.env.PLUGIN + '/lib/index.js')
for (const dep of ['undici', 'eventsource-parser', '@deepseek-ai/schemastery']) {
  try { req(dep + '/package.json'); console.log('OK', dep) }
  catch(e) { console.log('FAIL', dep, e.message.split('\n')[0]) }
}
EOF

# DSH config tree recognises the plugin
dsh web --dump-config 2>&1 | grep -A2 'llm-github'
```

Expected output for every check: version matches the released tag, `id` is
`@lujianjun19/dsh-llm-github-copilot`, all three deps print `OK`, and
`dump-config` shows `llm-github-copilot` in the tree.

### 5. Known prerequisites

- **pnpm ≥ 9** must be on `PATH` before any system-installed pnpm 7.x that may
  be present (e.g. via a Windows/WSL shared path). Install once with
  `npm install -g pnpm@latest` under the NVM Node version in use.
- **git URL rewrite** for HTTPS auth (set once per session before GitHub installs):
  ```bash
  TOKEN=$(python3 ~/.pi/agent/skills/github-auth/scripts/get_token.py)
  git config --global url."https://${TOKEN}@github.com/".insteadOf "https://github.com/"
  git config --global url."https://${TOKEN}@github.com/".insteadOf "git+ssh://git@github.com/"
  ```
  Clean up afterwards:
  ```bash
  git config --global --unset url."https://${TOKEN}@github.com/".insteadOf
  # or edit ~/.gitconfig to remove the [url] sections
  ```

## DeepSeek Harness compatibility

- Target APIs common to `@deepseek-ai/dsh` `0.1.1-rc.2` and `0.1.2-alpha.1`; route anything whose shape differs between them through `llmCompat()` (see “DeepSeek Harness version dependency” above).
- Prefer existing Harness services, slots, UI primitives, locale, credentials, settings, attachments, and model invalidation events.
- Do not patch DeepSeek Harness core from this repository.
- Browser UI must use Harness primitives/tokens and support English/Chinese with English fallback.

## Agent skills

### Issue tracker

Issues live in GitHub Issues (`gh` CLI). See `docs/agents/issue-tracker.md`.

### Triage labels

Default five-label vocabulary (`needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`). See `docs/agents/triage-labels.md`.

### Domain docs

Single-context layout — one `CONTEXT.md` + `docs/adr/` at the repo root. See `docs/agents/domain.md`.
