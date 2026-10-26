# Tasks

## 1. Version logic

- [x] 1.1 Add `scripts/version.mjs` and its types, `scripts/version.d.mts`, following `scripts/ci-paths.mjs`. Exports: `nextStable(version, bump)`, `prereleaseMinor(version)`, `nextPrerelease(version, tags)`, `newestPrereleaseTag(tags)` and `previousStableTag(version, tags)`. Add the CLI for the workflows in `scripts/version-cli.mjs`: `next-stable <bump>`, `next-prerelease`, `newest-prerelease-tag` and `previous-stable-tag <version>`, reading `package.json` and `git tag -l`. Verify with `test/version.test.ts`: every scenario in "Stable versions use even minors" and "Pre-release version numbers", ignoring malformed and `v*` tags when counting `pre-v*`, and numeric ordering (`0.5.10` > `0.5.9`). `npm test` passes.
- [x] 1.2 Add `publishCheck(version, marketplaceVersions)`, which returns `publish`, `finish` or a refusal reason, and `toPrune(versions, keep)`, which returns only pre-release versions beyond the newest `keep`. Verify with `test/version.test.ts`:
  - every scenario in "Publishing refuses builds that would not reach testers", plus "Third pre-release" and "Stable versions untouched"
  - fewer than `keep` versions
  - `keep = 0`

## 2. Stable release flow

- [x] 2.1 In `release.yml`'s bump job, replace `npm version "$BUMP"` with `npm version "$(node scripts/version-cli.mjs next-stable "$BUMP")" --no-git-tag-version --ignore-scripts`. Update the header comment to describe the even-minor rule. Verify that `node scripts/version-cli.mjs next-stable minor` prints 0.6.0 on 0.3.0, and run `actionlint` if available.
- [x] 2.2 In `ci.yml`'s `release` job, fetch `v*` tags and pass `--notes-start-tag "$(node scripts/version-cli.mjs previous-stable-tag "$version")"` to `gh release create`, with no start tag when there is no earlier stable tag. Verify with the 1.1 unit test, and run the CLI against the repo's tags (`0.3.0` gives `v0.2.0`).

## 3. Marketplace access

- [x] 3.1 Add `scripts/marketplace.mjs`:
  - `versions` prints `burnzy1148.agent-typewriter`'s versions with their pre-release flag as JSON.
  - `prune --keep <n> [--include <version>] [--dry-run]` deletes `toPrune`'s selection with the Gallery API's `deleteExtension(publisher, name, version)`. It re-checks each version's `Microsoft.VisualStudio.Code.PreRelease` property just before deleting and refuses otherwise.
  - It reads `VSCE_PAT`.
  - Add `azure-devops-node-api` as an explicit devDependency, pinned to the version vsce already resolves.
  
  Verify with `versions` and `prune --dry-run` locally against the live listing: they show 0.3.0 and 0.2.0 as stable and list nothing to delete. The selection itself is covered by 1.2.

## 4. Automatic tags

- [x] 4.1 Add the `prerelease-tag` job to `ci.yml` as `design.md` describes:
  - `if` on push to `refs/heads/develop` with extension changes, and `needs: [changes, test, package, integration-full]`.
  - Job-level `concurrency: prerelease-tag` without cancellation, and `permissions: contents: write`.
  - Steps: full-history checkout with tags. Skip the bump merge (the `package.json` version changed from `HEAD^`). Stop if the commit already has a `pre-v` tag. Compute the next version, stop unless the commit descends from the newest tag in its stream, then push the tag.
  
  Verify with `actionlint` if available. Exercise the step's shell in a scratch clone against crafted commits for each scenario in "Pre-release tag on each develop merge" and "Pre-release tags": a bump commit, an already tagged commit, an older commit after a newer tag, and a normal merge.
- [x] 4.2 Update `ci.yml`'s header comments: the tag job creates tags only, `pre-v` tags never publish stable, and the `release` job's notes start at the previous stable tag. Verify by reading them against `design.md`.

## 5. Manual publish

- [x] 5.1 Add `.github/workflows/prerelease.yml` as `design.md` describes:
  - `workflow_dispatch` with an optional `tag` input, `concurrency: prerelease-publish` without cancellation, `permissions: contents: write`, and `VSCE_PAT`.
  - Steps: resolve and validate the tag (`pre-v*`, an ancestor of `origin/develop`). Run `publishCheck` against `marketplace.mjs versions`. Check out the tag, `npm ci`, and package with `--pre-release --no-dependencies --no-update-package-json --no-git-tag-version`. Publish with `--pre-release --skip-duplicate`. Create the GitHub pre-release with the `.vsix` if it's missing, with notes starting at the previous published pre-release or stable tag. Prune the Marketplace (`--include` the version). Prune GitHub pre-releases beyond 2 without deleting tags.
  - A header comment explains how to run it and what it refuses.
  
  Verify with `actionlint` if available, and run the tag-resolution and refusal shell locally against the repo's tags and the live `versions` output. The first real publish is task 7.2.

## 6. Docs

- [x] 6.1 Add a "Pre-releases" part to CONTRIBUTING's "Releasing" section:
  - Automatic `pre-v` tags and which merges get one.
  - The even/odd minor rule, including the one-time 0.3.0 → 0.6.0 jump.
  - How to publish (`gh workflow run prerelease.yml` with or without `-f tag=pre-v<version>`) and what the workflow refuses.
  - What's pruned and kept, rerunning a failed publish, and removing all pre-releases (`marketplace.mjs prune --keep 0`).
  
  Verify that each command runs as written, using `--dry-run` for anything that would change the Marketplace.
- [x] 6.2 Update the release bullet in CLAUDE.md's Workflow section to mention automatic `pre-v` tags and the manual Pre-release workflow. Add a short "Pre-releases" note to the README's install section: the Marketplace's "Switch to Pre-Release Version" button, and that pre-releases are builds of `develop`. Add a CHANGELOG "Unreleased" line. Verify that `npm run package` still succeeds.

## 7. Integration checks

- [x] 7.1 Run `npm run typecheck`, `npm test` and `npm run package`, and validate the change with `openspec validate prerelease-from-develop --strict`. All pass.
- [ ] 7.2 After the PR merges into `develop`, confirm that CI tagged the merge `pre-v0.5.0` and published nothing. Then, with the maintainer's go-ahead, run the Pre-release workflow. Confirm that the Marketplace shows 0.3.0 as stable and 0.5.0 as a pre-release, that the GitHub release is marked pre-release with 0.3.0 still "Latest", and that the production site did not deploy.

## Workflow follow-up

- Archive the change on the PR branch once tasks 1–7.1 are done and CI is green, before merging. 7.2 is checked after the merge and recorded on bead at-lrk.
- Close bead at-lrk after the merge and the 7.2 check.
