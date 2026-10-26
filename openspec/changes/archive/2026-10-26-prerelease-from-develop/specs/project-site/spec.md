# Spec Delta

## MODIFIED Requirements

### Requirement: Production shows the released version
Production SHALL be deployed from `main` only, after a release merges. Changes merged into `develop` SHALL NOT appear on the production site until the next release. Tagging or publishing a pre-release SHALL NOT deploy production.

#### Scenario: Docs for an unreleased feature
- **WHEN** a PR merged into `develop` documents a feature that has not been released
- **THEN** the production site does not show it until the release that ships the feature merges into `main`

#### Scenario: Release with site changes
- **WHEN** a release PR that includes changes under `site/` merges into `main`
- **THEN** the production site is rebuilt and deployed from that commit

#### Scenario: Pre-release with site changes
- **WHEN** a PR that changes `site/` and `src/` merges into `develop`, is tagged, and is then published as a pre-release
- **THEN** the production site is not deployed
