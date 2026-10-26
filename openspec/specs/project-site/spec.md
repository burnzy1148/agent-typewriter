# project-site Specification

## Purpose

The public site at agent-typewriter.com: a landing page and documentation for the extension, kept in this repository so contributors edit it through pull requests and it ships with the released version.

## Requirements

### Requirement: Site served at the project domain
The site SHALL be served over HTTPS at https://agent-typewriter.com. Requests to https://www.agent-typewriter.com and to plain HTTP SHALL redirect permanently to the same path on https://agent-typewriter.com.

#### Scenario: Apex domain
- **WHEN** a visitor opens https://agent-typewriter.com
- **THEN** the landing page loads over HTTPS

#### Scenario: www redirect
- **WHEN** a visitor opens https://www.agent-typewriter.com/docs/settings/
- **THEN** they are redirected permanently to https://agent-typewriter.com/docs/settings/

### Requirement: Landing page
The page at `/` SHALL show a one-line description of the extension, the demo animation, how to install it from the Visual Studio Code Marketplace and from a `.vsix`, and links to the docs, the GitHub repository, and the Marketplace listing.

#### Scenario: Visitor wants to install
- **WHEN** a visitor opens the landing page
- **THEN** they see the `code --install-extension burnzy1148.agent-typewriter` command and a link to the Marketplace listing without scrolling past the demo

### Requirement: Documentation pages
The site SHALL have documentation pages for getting started, how replay works, highlights, the panels, session files, replaying git history, filtering (including the repository settings file, filter profiles and worktrees), lanes, settings, and limits. The settings page SHALL list every setting the extension contributes, with its type, default and description, taken from the extension's manifest so it cannot fall out of date.

#### Scenario: Settings page is complete
- **WHEN** the extension contributes a setting under `agentTypewriter.*`
- **THEN** the settings page built from the same commit lists that setting with its default and description, with no separate edit to the docs

#### Scenario: Navigating the docs
- **WHEN** a visitor is on any docs page
- **THEN** a sidebar lists every docs page and a search box finds text across them

### Requirement: Pages are editable through pull requests
Each documentation page SHALL be a Markdown file in the repository's `site/` folder and SHALL link to its source on GitHub as "Edit this page". Site changes SHALL go through pull requests to `develop` like any other change.

#### Scenario: Contributor fixes a typo
- **WHEN** a contributor clicks "Edit this page" on a docs page
- **THEN** GitHub opens that page's Markdown file on `develop` for editing

### Requirement: README stays a working entry point
The README SHALL keep the banner, the one-line description, the demo animation, install instructions and a short quick start, and SHALL link to the matching docs pages for everything else.

#### Scenario: Reading on the Marketplace
- **WHEN** someone reads the extension's Marketplace listing
- **THEN** they can install and start watching from the README alone, and follow a link to the full docs

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

### Requirement: Pull request previews
A pull request from a branch in this repository that changes the site SHALL get a preview deployment, and its URL SHALL be posted on the pull request. A pull request from a fork, or one opened by Dependabot, SHALL get the build check only, because its runs cannot read the deploy secret. Preview deployments SHALL expire on their own.

#### Scenario: Same-repository PR
- **WHEN** a maintainer opens a PR from a branch in this repository that changes `site/`
- **THEN** a comment on the PR gives a preview URL showing the site built from that branch

#### Scenario: Fork PR
- **WHEN** a contributor opens a PR from a fork that changes `site/`
- **THEN** the site build check runs and reports pass or fail, and no preview is deployed

#### Scenario: Dependabot PR
- **WHEN** Dependabot opens a PR that changes `site/package.json`, the root `package.json` or `.github/workflows/site.yml`
- **THEN** the site build check runs and reports pass or fail, and no preview is deployed

### Requirement: Site changes are checked in CI
Every pull request that changes the site SHALL run a site build check that fails on build errors and broken internal links. A pull request that changes only the site SHALL skip the extension's typecheck, unit tests, integration tests and packaging, while the extension's required checks still report success so the pull request can merge.

#### Scenario: Broken internal link
- **WHEN** a PR adds a docs link to a page that does not exist
- **THEN** the site build check fails

#### Scenario: Site-only PR
- **WHEN** a PR changes only files under `site/`
- **THEN** the extension's tests do not run, and the required checks `Test (ubuntu-latest)`, `Test (windows-latest)` and `Package .vsix` report success

#### Scenario: Mixed PR
- **WHEN** a PR changes files under `site/` and under `src/`
- **THEN** both the site build check and the full extension checks run

### Requirement: Site stays out of the extension package
The packaged `.vsix` SHALL contain no files from `site/` and none of the site's dependencies, and the site's dependencies SHALL NOT be installed by `npm ci` at the repository root.

#### Scenario: Packaging
- **WHEN** the maintainer runs `npm run package`
- **THEN** the `.vsix` file list contains nothing under `site/`

### Requirement: Extension links to the site
The extension's Marketplace listing SHALL link to https://agent-typewriter.com as its homepage.

#### Scenario: Marketplace homepage link
- **WHEN** someone opens the extension's Marketplace listing
- **THEN** its homepage link goes to https://agent-typewriter.com
