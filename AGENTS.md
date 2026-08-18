# Repository instructions

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

## Required workflow

Before editing:

```bash
git status --short
```

After editing:

```bash
npm run build
npm test
npm run check
git diff --stat
git diff
```

Commit source and generated `lib/` artifacts together. Use Conventional Commit-style messages.

Deploy only after tests pass:

```bash
npm run deploy
```

The deploy command creates a rollback backup and atomically replaces the profile package. Restart `dsh web` after Host changes; hard-refresh the browser after Client changes.

## Dependency management

`scripts/deploy.mjs` does **not** run `npm install` — it copies files directly.
Runtime `dependencies` must therefore be bundled manually:

1. Add the package to `dependencies` in `package.json` and run `npm install`.
2. Add the same name to `bundledDependencies` in `package.json`.
3. Add the same name to the `bundledDeps` array in `scripts/deploy.mjs`.

This ensures both `npm run deploy` (copies from local `node_modules/`) and
`npm publish` (uses `bundledDependencies` tarball) include the runtime dep.
`peerDependencies` and `devDependencies` are excluded from both lists.

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

## DeepSeek Harness compatibility

- Target the installed `@deepseek-ai/dsh` rc.6 APIs unless a compatibility change is explicitly approved.
- Prefer existing Harness services, slots, UI primitives, locale, credentials, settings, attachments, and model invalidation events.
- Do not patch DeepSeek Harness core from this repository.
- Browser UI must use Harness primitives/tokens and support English/Chinese with English fallback.
