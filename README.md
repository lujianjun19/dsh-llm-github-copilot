# dsh-llm-github-copilot

GitHub Copilot LLM adapter and Web settings integration for DeepSeek Harness.

## Repository role

This Git repository is the **source of truth**. Do not edit the installed copy under
`~/.dsh/profiles/web/node_modules` directly.

- Repository: `/home/ljjun/repos/dsh-llm-github-copilot`
- Deployment target: `~/.dsh/profiles/web/node_modules/@deepseek-ai/dsh-llm-github-copilot`
- Local packages: `dist/*.tgz`
- Deployment backups: `~/.dsh/plugin-backups/dsh-llm-github-copilot/`

## Source layout

The released Host and Client files share lexical state, so the source is maintained as
ordered, small fragments and concatenated deterministically. This preserves the reviewed
runtime while avoiding one 1,800-line editing surface.

```text
src/
├── host/
│   ├── 00-imports.js
│   ├── 01-constants.js
│   ├── 02-schema.js
│   ├── 03-serialize.js
│   ├── 04-sse-translate.js
│   ├── 05-responses-api.js
│   ├── 06-token-exchange.js
│   ├── 07-transport.js
│   ├── 08-adapter.js
│   ├── 09-model-discovery.js
│   ├── 10-config-resolution.js
│   ├── 11-device-flow.js
│   ├── 12-apply.js
│   └── 99-exports.js
└── client/
    ├── 00-wrapper-start.js
    ├── 01-i18n.js
    ├── 02-locale.js
    ├── 03-styles-api.js
    ├── 04-stores.js
    ├── 05-common-components.js
    ├── 06-login-dialog.js
    ├── 07-settings-page.js
    ├── 08-login-command.js
    ├── 09-settings-nav-icon.js
    ├── 10-apply.js
    └── 99-wrapper-end.js
```

`lib/index.js` and `lib/client.js` are generated release artifacts. Modify `src/`, then build.

## Commands

```bash
npm run build       # concatenate fragments and syntax-check artifacts
npm test            # deterministic build, metadata, i18n, and packaging tests
npm run check       # build + tests + npm package dry-run
npm run deploy      # test, build, atomically deploy, retain a rollback backup
npm run pack:local  # create dist/deepseek-ai-dsh-llm-github-copilot-*.tgz
```

After Host changes, restart DSH:

```bash
# Stop the existing process, then:
dsh web
```

After Client-only changes, HMR may reload the bundle, but a hard refresh is still recommended:

```text
Ctrl+Shift+R
```

## Development workflow

1. Work only in this repository.
2. Inspect `git status --short` before editing.
3. Change the smallest relevant fragments in `src/`.
4. Run `npm run check`.
5. Review `git diff`.
6. Commit the source and generated `lib/` artifacts together.
7. Bump SemVer for a release (`npm version patch|minor|major`).
8. Run `npm run deploy`.
9. Restart DSH for Host changes and complete the browser smoke test.

## Versioning

Semantic Versioning is used:

- **patch**: bug fixes, UI copy/style corrections, no new public capability;
- **minor**: new OAuth, model, vision, or document capability;
- **major**: incompatible configuration, credential, provider route, or wire changes.

`npm version` runs tests before tagging and rebuilds the release artifacts. Update
`CHANGELOG.md` before invoking it.

## Rollback

`npm run deploy` moves the currently installed package into a timestamped backup before
installing the new build. To roll back, stop DSH and replace the target directory with the
wanted backup from:

```text
~/.dsh/plugin-backups/dsh-llm-github-copilot/
```

## License

MIT
