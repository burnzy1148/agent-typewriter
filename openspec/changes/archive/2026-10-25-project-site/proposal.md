# Proposal

## Why

All of Agent Typewriter's documentation lives in a 245-line README, which is hard to scan and link into, and there is no home page to point people at beyond the Marketplace listing. Now that agent-typewriter.com is registered, an open-source site in this repository can give the project a landing page and browsable docs. Contributors can improve it through the same pull requests as the code, and docs can change in the same PR as the feature they describe.

## What Changes

- New `site/` folder in this repository: an Astro + Starlight static site with its own `package.json` and lockfile, separate from the extension's dependencies.
- A landing page at `/`: one-line pitch, the demo GIF, install instructions (Marketplace and `.vsix`), and links to the docs, GitHub, and the Marketplace listing.
- Docs pages split out of the README: getting started, how it works, highlights, the panels, session files, replaying git history, filtering (repository settings file, filter profiles, worktrees), settings, and limits. Each page has an "Edit this page" link to its source on GitHub.
- The README becomes shorter: banner, pitch, demo GIF, install, a short quick start, and links to the matching docs pages. It still reads well on the Marketplace and on GitHub.
- Hosted on Firebase Hosting at agent-typewriter.com, with `www` redirecting to the apex domain. Production deploys when a release lands on `main`, so the site describes the published version. Same-repository pull requests that touch the site get a Firebase preview channel URL. Pull requests from forks get a build check but no preview, because they cannot read the deploy secret.
- CI builds the site on every PR that touches `site/`. PRs that touch only `site/` skip the extension's typecheck, unit and integration tests, but the required checks still report so the PR can merge.
- `site/` is never packaged into the `.vsix`.
- The extension's `homepage` in `package.json` points at https://agent-typewriter.com.
- CONTRIBUTING.md explains how to run the site locally and where docs pages live.

## Capabilities

### New Capabilities
- `project-site`: the public site at agent-typewriter.com: what pages it has, where its source lives and how it is edited, how it is built and deployed (production, previews), how site-only changes are checked in CI, and how it stays out of the extension package.

### Modified Capabilities
None. The extension's runtime behavior does not change.

## Impact

- New: `site/` (Astro + Starlight project, landing page, docs content, `firebase.json` and `.firebaserc`), and a new workflow `.github/workflows/site.yml` for site builds, previews and production deploys.
- `.github/workflows/ci.yml`: a path check so site-only PRs skip the extension's steps while the required checks `Test (ubuntu-latest)`, `Test (windows-latest)` and `Package .vsix` still report success.
- `.github/workflows/release.yml`: nothing changes. Production deploys run on the push to `main` that merging a release PR makes, when it touches the site.
- `.vscodeignore`: already uses an allow-list (`**` then `!` entries), so `site/` is excluded without edits. A check confirms it.
- `package.json`: `homepage` field. `README.md`, `CONTRIBUTING.md` and `CLAUDE.md` (a `site/` line under Architecture and Commands).
- New repository secret for the Firebase service account, plus a Firebase project and DNS records for agent-typewriter.com and www, set up by the maintainer.
- No change to `src/` or the extension's runtime.
