# Tasks

## 1. Site scaffold

- [x] 1.1 Create `site/` as a standalone Astro + Starlight project (own `package.json` and `package-lock.json`, Node 22, no root workspaces), with `site/public/` copies and `dist/` gitignored. Verify `npm ci && npm run build` in `site/` succeeds and root `npm ci` installs nothing from `site/`
- [x] 1.2 Configure Starlight: title, logo from the extension icon, GitHub social link, `editLink.baseUrl` pointing at `site/` on `develop`, and `starlight-links-validator`. Verify a deliberately broken relative link fails `npm run build`, then remove it
- [x] 1.3 Add the `prebuild` script that copies `images/demo.gif`, `images/banner.png` and `images/icon.png` into `site/public/`. Verify the built `dist/` contains them and `git status` shows no new tracked files

## 2. Content

- [x] 2.1 Add the landing page (`index.mdx`, `splash` template): pitch, demo GIF, Marketplace install command and `.vsix` instructions, links to the docs, GitHub and the Marketplace listing, and the documented extension version from the root `package.json`. Verify in `npm run dev` that the install command and Marketplace link are visible above the fold at 1280×800 and at phone width
- [x] 2.2 Move the README sections into docs pages: getting started, how it works, highlights, the panels, session files, replaying git history, filtering (repository settings file, filter profiles, worktrees), and limits, with text carried over and cross-references turned into relative links. Verify every page appears in the sidebar, Pagefind search finds a phrase from each, and the link validator passes
- [x] 2.3 Add the settings component that renders `contributes.configuration` from the root `package.json` (name, type, default, `markdownDescription` or `description`) and the settings page using it, plus the prose on the repository settings file and `ignoreOwnSaves`. Verify the page lists every `agentTypewriter.*` setting in `package.json` (compare counts in the built HTML) and that adding a dummy setting locally makes it appear with no docs edit
- [x] 2.4 Trim the README to banner, pitch, demo, Install, a short Use section, a Documentation list of absolute links to each docs page, Develop, Contributing and License. Verify every docs link resolves against a local build and `npm run package` still bundles the README

## 3. Hosting and deploy

- [x] 3.1 Add `site/firebase.json` (`public: dist`, `cleanUrls`, `trailingSlash: true`, long cache on `/_astro/**`, short cache on HTML) and `site/.firebaserc` with default project `agent-typewriter-web`. Verify with `npx firebase-tools emulators:start --only hosting` from `site/` that `/docs/settings/` and `/docs/settings` both serve the page and an unknown path serves the 404 page
- [ ] 3.2 Add `.github/workflows/site.yml` with `build` (PR and push to `develop`/`main`, path-filtered, uploads `dist`), `preview` (same-repository PRs only, channel per PR, `expires: 7d`, posts the URL) and `deploy` (push to `main` and `workflow_dispatch` on `main`, `live` channel), using the `FIREBASE_SERVICE_ACCOUNT` secret. Verify on this change's PR that `build` passes and a preview URL is posted, and that `deploy` shows as skipped

## 4. CI shortcut for site-only PRs

- [x] 4.1 Add `scripts/ci-changes.mjs` exporting the classification (site-only when every path is under `site/` or is `.github/workflows/site.yml`) with a small CLI that writes `extension=true|false` to `$GITHUB_OUTPUT`. Verify with `test/ciChanges.test.ts`: site-only, mixed, `images/` only, `package.json` only, empty list (runs everything), and a rename out of `site/`
- [ ] 4.2 Add the `changes` job to `ci.yml` and gate every step after checkout in `test` and `package` on its output, keeping job names unchanged; non-PR events always run everything. Verify on a throwaway site-only PR that the three required checks report success without running tests, and on this change's PR (which touches more than `site/`) that the full suite runs

## 5. Repository wiring

- [x] 5.1 Set `homepage` in `package.json` to `https://agent-typewriter.com`, and confirm `.vscodeignore` needs no change. Verify `npx vsce ls` lists nothing under `site/` and the manifest in the built `.vsix` has the new homepage
- [x] 5.2 Document the site in CONTRIBUTING.md (running it locally, where docs pages live, previews only for same-repository PRs, production follows releases) and in CLAUDE.md (a `site/` line under Architecture and the site commands under Commands). Add an `## Unreleased` CHANGELOG line. Verify the commands in CONTRIBUTING.md run as written from a clean checkout

## Workflow follow-up

- Maintainer setup before 3.2 can be verified: the `FIREBASE_SERVICE_ACCOUNT` repository secret for `agent-typewriter-web`, the custom domains, and the Namecheap DNS records (design.md, Migration Plan step 1).
- Archive the change on the PR branch once its tasks are done and CI is green.
- Launch check after the release that carries this change: run `site.yml` with `workflow_dispatch` on `main` if the release did not deploy, then confirm https://agent-typewriter.com loads over HTTPS, `http://` and `https://www.agent-typewriter.com/docs/settings/` redirect permanently to the apex path, and the Marketplace listing's homepage link goes to the site. Close bead at-0pw after it passes.
