# Changelog

All notable changes to this project are documented here. The project follows Semantic Versioning.

## [Unreleased]

### Planned

- Dynamic GitHub Copilot vision-model capability discovery and image serialization.

## [0.2.1] - 2026-08-17

### Added

- Self-contained implementation handoff for Copilot vision support and the separate document-reading tool.
- Release packaging and deployment of repository governance and design documents.

## [0.2.0] - 2026-08-17

### Added

- GitHub OAuth device-flow login, status, and logout commands.
- Harness-styled GitHub Copilot Settings page with English and Chinese localization.
- Automatic login-dialog close after OAuth credential commit.
- Automatic model-directory refresh after credential changes.
- Logout confirmation through the Harness popup and risk-confirmation components.
- GitHub Copilot Settings navigation icon.
- Deterministic source-fragment build, tests, atomic deployment, packaging, and Git workflow.

### Changed

- Unauthenticated and failed-auth catalogs no longer advertise unusable fallback models.
- Source ownership moved from the live DSH profile to this repository.
