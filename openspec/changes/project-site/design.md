# Design

## Context

- The README is the only documentation. `vsce` shows it on the Marketplace and rewrites its relative links and images to GitHub URLs.
- `.vscodeignore` is an allow-list: `**` excludes everything, then `!` lines add back what ships. A new `site/` folder is excluded with no edit.
- `ci.yml` runs on every `pull_request`. The `develop` ruleset requires three checks: `Test (ubuntu-latest)`, `Test (windows-latest)` (a matrix job named `Test (${{ matrix.os }})`) and `Package .vsix`. A required check that never reports blocks the merge.
- `release.yml` merges `release/v<version>` into `main` with a merge commit and then tags it. `main` receives nothing else.
- The demo GIF is `images/demo.gif`, re-recorded by `npm run demo`. The banner is `images/banner.png`.

## Goals / Non-Goals

**Goals:**
- A contributor can change a docs page by editing one Markdown file, with no framework knowledge.
- The extension's existing CI, release flow and package are unaffected apart from the site-only shortcut.
- Assets and the settings reference have one source each.

**Non-Goals:**
- Versioned docs (one version: the latest release).
- Analytics, cookies, comments, a blog or a changelog page. The GitHub releases page stays the changelog.
- Translations.
- Deploying anything from forks, or production deploys from `develop`.

## Decisions

### Astro + Starlight in `site/`, not an npm workspace

`site/` is a standalone npm project with its own `package.json` and `package-lock.json`. The root `package.json` does not declare workspaces, so `npm ci` at the root and the extension's CI cache stay exactly as they are, and the site's dependency updates never touch the extension's lockfile.

Starlight gives the sidebar, Pagefind search, dark mode, "Edit this page" links and a splash landing template out of the box. Docs pages are `.md` files under `site/src/content/docs/`. The landing page is `site/src/content/docs/index.mdx` with Starlight's `splash` template and `hero`, so it is also plain content rather than a custom Astro page.

Alternatives: plain HTML (no search or sidebar, awkward past one page), VitePress (similar, but a custom landing page means Vue components). Chosen with the maintainer.

### Shared assets copied at build time

A `prebuild` script in `site/package.json` copies `../images/demo.gif`, `../images/banner.png` and `../images/icon.png` into `site/public/` (gitignored). `npm run demo` keeps writing to `images/`, and the README and site always show the same files. A symlink was rejected because Windows checkouts handle symlinks inconsistently.

### Settings reference generated from `package.json`

A Starlight component reads `contributes.configuration` from the root `package.json` at build time and renders the settings table (name, type, default, description, with `markdownDescription` preferred). The settings page holds only that component plus prose about the repository settings file and `ignoreOwnSaves`. This replaces the hand-maintained table in the README, so a new setting cannot be left out. Vite's `server.fs.allow` includes the repository root so the dev server can read the file too.

### README trimmed, docs moved

The README keeps the banner, pitch, demo, Install, a five-line Use section, and a "Documentation" list linking each docs page at `https://agent-typewriter.com/docs/...`. Develop, Contributing and License stay. Each moved section becomes one docs page, with the text carried over and edited only where it referred to "below" or "above". Links between docs pages are root-relative (`/docs/settings/`), which the link validator checks; it rejects plain relative links.

### Firebase Hosting config inside `site/`

`site/firebase.json` serves `dist/` with `cleanUrls: true` and `trailingSlash: true` (matching Astro's directory output), long cache headers for `/_astro/**` (hashed file names) and a short cache for HTML. `site/.firebaserc` sets the default project to `agent-typewriter-web`, which the deploy action also uses as its `projectId`. Keeping both in `site/` leaves the repository root unchanged, and the deploy action takes `entryPoint: site`.

HTTPS and the HTTP redirect come from Firebase Hosting. `www.agent-typewriter.com` is added in the Firebase console as a custom domain that redirects to the apex domain, so no redirect rules live in `firebase.json`.

### `site.yml` for build, preview and production

One workflow with three jobs:

- `build` runs on `pull_request` and `push` to `develop` and `main`, filtered to `site/**`, `images/**`, `package.json` (settings reference) and the workflow itself. It runs `npm ci` and `npm run build` in `site/`. `starlight-links-validator` fails the build on broken internal links. It uploads `site/dist` as an artifact.
- `preview` needs `build` and runs only when `github.event.pull_request.head.repo.full_name == github.repository`. It deploys the artifact with `FirebaseExtended/action-hosting-deploy` to a channel named after the PR, `expires: 7d`, and the action posts the URL on the PR. Fork PRs skip it because their runs cannot read secrets.
- `deploy` needs `build` and runs on `push` to `main` and on `workflow_dispatch` when `github.ref == 'refs/heads/main'`. It deploys to the `live` channel. A release merge touching the site triggers it, and `workflow_dispatch` covers a re-deploy without a release (for example after DNS setup).

The Firebase service account key is the `FIREBASE_SERVICE_ACCOUNT` repository secret, only readable by jobs on this repository's branches. `site.yml` is not a required check: it only runs when the site changes, and a required check that never runs would block every other PR.

Alternative: put the site jobs in `ci.yml`. Rejected to keep the extension pipeline readable and so site workflow edits do not restart extension runs.

### Site-only PRs skip the extension steps, not the jobs

`ci.yml` gets a `changes` job. On `pull_request` it lists files changed against the base with `git diff --name-only` and passes them to `scripts/ci-changes.mjs`, which sets `extension=false` when every path is under `site/` or is `.github/workflows/site.yml`. The classification is a pure exported function so a unit test covers it. On other events it always sets `extension=true`. `test` and `package` keep their names and `needs: changes`, and each step after checkout has `if: needs.changes.outputs.extension == 'true'`. The jobs run and succeed in seconds, so the required checks report under their exact names.

A workflow-level `paths-ignore` was rejected because the required checks would never report. A job-level `if:` was rejected because a skipped matrix job reports as `Test (${{ matrix.os }})`, not the two required names. `dorny/paths-filter` would work but adds a third-party action for a few lines of shell.

A change to `images/` or `package.json` is not site-only, so it runs the full extension checks as it does today.

## Risks / Trade-offs

- [Docs on `develop` describe unreleased features while production shows the release] → Previews show the `develop` state on PRs. The site says which extension version it documents, taken from `package.json`.
- ["Edit this page" opens the file on `develop`, which can differ from the released page] → That is where edits must land anyway. The difference is small between releases.
- [A site-only typo fix waits for the next release] → Accepted trade-off. A patch release ships it, and `workflow_dispatch` on `main` re-deploys without one.
- [The `changes` check misclassifies a mixed PR as site-only and skips extension tests] → It treats any path outside `site/` as an extension change, defaulting to running everything. A unit check of the classification script covers the edge cases (renames, deleted files).
- [Firebase action or Astro major updates break the build] → `site/package-lock.json` pins versions and the action is pinned to a major tag, so updates only happen when someone changes them. A broken site build never blocks extension PRs.
- [The README loses detail people read on the Marketplace] → It keeps install and quick start and links straight to each docs page.

## Migration Plan

1. Maintainer, in the `agent-typewriter-web` Firebase project: add `agent-typewriter.com` and `www.agent-typewriter.com` (set to redirect to the apex) as Hosting custom domains, and add the `FIREBASE_SERVICE_ACCOUNT` secret (a service account key with the Firebase Hosting Admin and Service Usage Consumer roles; without the second, the deploy fails with a 403 on `serviceusage.services.get`). In Namecheap's Advanced DNS for the domain, remove the default parking records (the `@` URL Redirect and the `www` CNAME to `parkingpage.namecheap.com`), then add the A and TXT records the Firebase console shows for each host, with `@` for the apex and `www` for www. The console turns green and issues the certificates once DNS propagates.
2. Merge the PR into `develop`. The README on `develop` links to the site before it is live. That is acceptable because the Marketplace only shows the README after a release.
3. The next release merges into `main`. `deploy` publishes the site, and the Marketplace listing picks up the new `homepage` and README.
4. Rollback: re-deploy a previous version from the Firebase Hosting console (it keeps release history), or revert the site change on `develop` and release.
