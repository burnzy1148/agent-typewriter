# Design

## Context

Two workflows publish today, and both publish stable releases only:
- `release.yml`. Its `bump` job runs `npm version <bump>` on `develop` and opens `bump/v<version>`. Its `tag` job tags that PR's merge `v<version>` and opens `release/v<version>` into `main`. Its `publish` job dispatches `ci.yml` on the tag once the release PR merges.
- `ci.yml`. It runs on pushes to `main` and `develop`, on PRs, and on dispatch. Its jobs are `changes` (is anything outside the site touched), `unit`, `integration`, `integration-full` (not on PRs), the `test` roll-up, and `package` (uploads the `.vsix` artifact). The `release` job runs only on `refs/tags/v*`. It checks the tag against `package.json`, runs `vsce publish --packagePath *.vsix --skip-duplicate`, then `gh release create --generate-notes`. The workflow's concurrency group is `ci-${{ github.ref }}` with `cancel-in-progress: true`, so a newer push to `develop` cancels the older run.

Spike results (2026-10-26, throwaway extension `burnzy1148.agent-typewriter-spike`, since unpublished):
- `vsce package <ver> --pre-release --no-update-package-json --no-git-tag-version` stamps the version and the pre-release flag into the `.vsix` and leaves `package.json` alone. `--no-dependencies` is needed, as CI already uses.
- The Marketplace accepted stable 0.6.0 and 0.6.1 after pre-release 0.7.0, and recorded the flags correctly.
- `vsce unpublish` removes a whole extension only. The Gallery API's `deleteExtension(publisher, name, version)` from `azure-devops-node-api` removed a single version and left the rest. The version listing showed a new version about 20 seconds after publishing.

## Goals / Non-Goals

**Goals:**
- A `pre-v` tag always means "this `develop` commit passed full CI". Publishing never re-decides that.
- All version arithmetic, tag choice, publish checks and pruning selection live in one pure module with unit tests. The workflows only call it.
- Every step can be rerun: a rerun converges on the same tag, version, release and pruned set.
- The stable flow changes in exactly two places: the `minor` computation and the release-notes start tag.

**Non-Goals:**
- Tagging every single merge. A merge whose run is cancelled by the next merge is covered by the next tag.
- Publishing without a maintainer running the workflow.
- Republishing a version number that was removed.

## Decisions

### Tag automatically, publish by hand

CI tags each green `develop` commit. A separate, dispatch-only workflow publishes a chosen tag.
- Considered: publishing on every merge. Rejected because of about 15 merges a day, many of which ship nothing new. Testers would get a stream of identical builds, and the PAT would publish and delete versions unattended.
- Considered: an input on `ci.yml`'s dispatch that tests, tags and publishes in one run. Rejected because it repeats the full test suite for a commit that already passed, and it gives builds version numbers only when someone publishes. Automatic tags give every tested build a stable name you can refer to, install from or publish later.

### Version numbers come from `package.json` plus tags

The pre-release minor is derived from `develop`'s `package.json`, and `N` from the highest existing `pre-vM.P.*` tag. Tags are never deleted, because they are the counter.
- Considered: `github.run_number` as `N`. Rejected because the numbers gap and jump, it resets if the workflow is renamed, and it doesn't restart when a new stream starts.
- Considered: committing a version bump to `develop` on every merge. Rejected because it needs a bot to push to a protected branch, and it would trigger CI again.

The rule "first odd minor above the stable minor" also works from today's odd 0.3.0, so no one-off migration commit is needed.

### `pre-v` tag prefix

Stable tags stay `v<version>`. The `release` job keys on `refs/tags/v*`, and the bump and tag jobs check `refs/tags/v<version>`. A `pre-v` prefix can't match either.
- Considered: plain `v0.5.2` tags. Rejected because dispatching CI on one would run the stable `release` job, which only checks that the tag matches `package.json`.

### Tags rise along history

The workflow-level `cancel-in-progress` stays, so a merge followed quickly by another is folded into the next tag. A late or rerun job for an older commit could still finish after a newer commit was tagged. The tag job therefore tags only if the commit descends from the commit of the newest tag in its stream (`git merge-base --is-ancestor`). The job-level `concurrency: { group: prerelease-tag, cancel-in-progress: false }` serializes the check-then-push.
- Considered: not cancelling `develop` runs, so every merge gets a tag. Rejected because it roughly doubles CI minutes on busy days, and runs can still finish out of order, so the ancestry check would be needed anyway.

### Shared script `scripts/version.mjs`

It exports pure functions, with types in `scripts/version.d.mts` and tests in `test/version.test.ts`, as `scripts/ci-paths.mjs` and `test/ciChanges.test.ts` already do:
- `nextStable(version, bump)` gives `patch`/`major` as `npm version` does, and `minor` as `M.(P+1).0`.
- `prereleaseMinor(version)`.
- `nextPrerelease(version, tags)`.
- `newestPrereleaseTag(tags, stream?)`.
- `previousStableTag(version, tags)`.
- `publishCheck(version, marketplaceVersions)` returns `publish`, `finish` (already published, so complete the remaining steps) or a refusal reason.
- `toPrune(versions, keep = 2)` takes `{version, preRelease}` items and returns only pre-release versions beyond the newest `keep`, by numeric semver.

`scripts/version-cli.mjs` wraps them for the workflows, as `scripts/ci-changes.mjs` wraps `ci-paths.mjs`. `release.yml` replaces `npm version "$BUMP"` with `npm version "$(node scripts/version-cli.mjs next-stable "$BUMP")"`. The rest of the bump job is unchanged.

### `scripts/marketplace.mjs`

It uses `azure-devops-node-api`'s Gallery API with `VSCE_PAT`. It has two subcommands:
- `versions` prints each version and its pre-release flag as JSON.
- `prune --keep N [--include V] [--dry-run]` deletes what `toPrune` returns. `--include` adds a just-published version that the listing may not show yet. Just before deleting, it re-checks that each version carries the `Microsoft.VisualStudio.Code.PreRelease` property and refuses otherwise.

### `prerelease-tag` job in `ci.yml`

- `if: github.event_name == 'push' && github.ref == 'refs/heads/develop' && needs.changes.outputs.extension != 'false'`
- `needs: [changes, test, package, integration-full]`
- Job-level concurrency as described above, and `permissions: contents: write`. It doesn't need `VSCE_PAT`.

Steps: check out with `fetch-depth: 0`, which brings the tags, then run `scripts/prerelease-tag.sh` and push the tag it prints, if any. The script is shell so it can be tested against crafted commits in a scratch repository:
1. Skip the bump merge: `package.json`'s `version` differs from `HEAD^`'s.
2. If a `pre-v*` tag is already on `HEAD`, stop.
3. If `HEAD` doesn't descend from the newest tag in its stream, stop.
4. If only the site changed since the newest tag in the stream, or since `v<version>` when the stream has none, stop. `ci.yml`'s `changes` job classifies paths on pull requests only, so a push has to be checked here. Diffing from the last tag, not from `HEAD^`, keeps the changes of a cancelled run counted when a site-only merge follows them. It uses the same `scripts/ci-changes.mjs` classification as pull requests.
5. Create the `nextPrerelease` tag locally and print it.

### `prerelease.yml` workflow

- `on: workflow_dispatch` with an optional `tag` input.
- `concurrency: { group: prerelease-publish, cancel-in-progress: false }`, `permissions: contents: write`, and `VSCE_PAT`.

Steps:
1. Fetch tags. Resolve the tag: the input, or `newestPrereleaseTag` among tags reachable from `GITHUB_SHA`, the dispatched commit. A rerun keeps `GITHUB_SHA`, so it resolves the same tag even after CI has tagged newer merges. Refuse anything not `pre-v*`, or whose commit is not an ancestor of `origin/develop`.
2. Run `publishCheck` against `marketplace.mjs versions`. Refuse, or continue in `publish` or `finish` mode.
3. Check out the tag, `npm ci`, then `npx vsce package "$VERSION" --pre-release --no-dependencies --no-update-package-json --no-git-tag-version`. It doesn't rerun the tests, because the tag means CI passed on this commit. It doesn't reuse a CI artifact, because those expire and are packaged as stable.
4. `npx vsce publish --pre-release --packagePath *.vsix --skip-duplicate`.
5. If the GitHub release is missing, create it: `gh release create "$TAG" *.vsix --prerelease --generate-notes --notes-start-tag <previous published pre-release, else previous stable tag>`.
6. `marketplace.mjs prune --keep 2 --include "$VERSION"`.
7. Prune GitHub: list pre-releases with `pre-v` tags and `gh release delete <tag> --yes` beyond the newest 2, without `--cleanup-tag`.

Only maintainers with write access can dispatch it.

### Stable release notes

In `ci.yml`'s `release` job, `gh release create` gets `--notes-start-tag "$(node scripts/version-cli.mjs previous-stable-tag "$version")"`. The checkout fetches `v*` tags to find it.

### Docs

- CONTRIBUTING's "Releasing" section gains a "Pre-releases" part: tags, how to publish, what's pruned, and how to rerun.
- The CLAUDE.md workflow bullet.
- A README "Pre-releases" note: the Marketplace's "Switch to Pre-Release Version" button.
- A CHANGELOG "Unreleased" line.

## Risks / Trade-offs

- [`VSCE_PAT` can now delete versions] → Deletion runs only in the dispatch-only workflow. It only removes versions that carry the pre-release flag and are outside the newest 2. That selection is unit tested, and stable deletes are refused in code.
- [A tag's build is packaged later than it was tested] → It's the same commit and the same lockfile (`npm ci`). The only difference is the stamped version and the pre-release flag.
- [Published pre-release numbers have gaps, e.g. 0.5.3 then 0.5.9] → Expected. The numbers show which tested build testers have.
- [The tag job is skipped when a quick follow-up merge cancels the run] → The next tag includes that commit. Tags are a record of tested builds, not of every merge.
- [Pre-release users jump past a stable release]: for example, 0.7.x is published between the bump merge for 0.6.0 and the release PR merging. The spike confirmed this is accepted. Pre-release users stay ahead, on code that includes 0.6.0.
- [A stable patch while pre-releases exist, e.g. 0.3.1 after 0.5.x] → Pre-release users don't get it, but they're on `develop`, which has the fix.
- [The minor bump skips numbers (0.3.0 to 0.6.0)] → One-time, and documented in the CHANGELOG and CONTRIBUTING.

## Migration Plan

1. Merge the PR into `develop`. Its push gets tag `pre-v0.5.0` once CI passes. Nothing is published.
2. When the maintainer chooses, run the Pre-release workflow. Check that the Marketplace shows 0.5.0 as a pre-release and 0.3.0 as stable, and that the GitHub release is marked pre-release with 0.3.0 still "Latest".
3. The next minor stable release is cut as usual and becomes 0.6.0.

Rollback: remove the tag job and the Pre-release workflow. Existing pre-release versions can be removed with `marketplace.mjs prune --keep 0`. After any pre-release has shipped, keep the `minor` rule, so the next stable release still sorts above the pre-releases.
