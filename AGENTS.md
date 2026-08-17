# Repository instructions

## Source of truth

- Work only in `/home/ljjun/repos/dsh-llm-github-copilot`.
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

## Releases

- Update `CHANGELOG.md` before a release.
- Use SemVer with `npm version patch|minor|major`.
- Build a local release artifact with `npm run pack:local`.
- Do not reuse a released version for changed runtime code.

## DeepSeek Harness compatibility

- Target the installed `@deepseek-ai/dsh` rc.6 APIs unless a compatibility change is explicitly approved.
- Prefer existing Harness services, slots, UI primitives, locale, credentials, settings, attachments, and model invalidation events.
- Do not patch DeepSeek Harness core from this repository.
- Browser UI must use Harness primitives/tokens and support English/Chinese with English fallback.
