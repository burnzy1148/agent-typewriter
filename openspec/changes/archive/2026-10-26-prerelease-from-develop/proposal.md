# Proposal

## Why

Work merged into `develop` reaches users only when a stable release is cut, so testers have to build and install a `.vsix` by hand to try it. The Marketplace has a pre-release channel ("Switch to Pre-Release Version"). `develop` takes about 15 merges a day, and many of them are spec archives, CI tweaks or dependency bumps. So every green merge should be versioned and tagged automatically, but a maintainer should choose which builds testers get.

## What Changes

- **Automatic pre-release tags.** After CI passes on a push to `develop` that changes the extension, CI tags that commit `pre-v<version>` with the next pre-release version. Tagging publishes nothing. `package.json` on `develop` keeps the stable version.
- **Manual publish.** A new Pre-release GitHub Actions workflow, run from the Actions tab or `gh workflow run`, publishes a `pre-v` tag to the Marketplace's pre-release channel and as a GitHub pre-release. It takes an optional tag and defaults to the newest. It refuses a build that testers wouldn't receive because the Marketplace already has a higher version.
- **Odd and even minors.** Pre-releases use the odd minor just above the current stable minor, so a pre-release always sorts above the stable release it follows and below the next one. From 0.3.0, pre-releases are 0.5.0, 0.5.1, and so on.
- **BREAKING (release process):** the Release workflow's `minor` bump goes to the next even minor above the pre-release stream instead of the next minor. The next minor release after 0.3.0 is 0.6.0, not 0.4.0. `patch` and `major` bumps are unchanged.
- **Up to 2 pre-releases kept.** After publishing, the Pre-release workflow removes older pre-release versions from the Marketplace and older pre-release GitHub releases, keeping the newest 2 of each. Stable versions are never removed, and `pre-v` tags are kept.
- **Release notes.** The stable GitHub release's generated notes start at the previous stable tag, so pre-releases don't cut them short.
- The version-bump merge gets no `pre-v` tag. Stable releases keep their current flow: bump PR, `v<version>` tag on `develop`, release PR into `main`, publish from the tag.
- Docs for maintainers (CONTRIBUTING, CLAUDE.md) and for testers (README) describe the channels.

Out of scope:
- Publishing pre-releases automatically or on a schedule.
- Publishing to Open VSX.
- Pre-releases from branches other than `develop`, or from pull requests.
- Changing the stable release's approval steps.

## Capabilities

### New Capabilities

- `release-publishing`: how the extension is versioned, tagged and published to the Marketplace on the stable and pre-release channels, and how many pre-releases are kept.

### Modified Capabilities

- `project-site`: "Production shows the released version" now states explicitly that tagging or publishing a pre-release does not deploy the production site.

## Impact

- `.github/workflows/ci.yml`: a new `prerelease-tag` job on pushes to `develop`. The `release` job's GitHub release notes start at the previous stable tag.
- New `.github/workflows/prerelease.yml`: the manual publish.
- `.github/workflows/release.yml`: the bump job computes the `minor` version with the shared script.
- New `scripts/version.mjs`: next stable and pre-release versions, the tag to publish, publish checks, and which pre-releases to prune. Unit tests in `test/`.
- New `scripts/marketplace.mjs`: lists the Marketplace's versions and removes pre-release versions through the Gallery API, using `azure-devops-node-api`, which `@vscode/vsce` already depends on.
- `CONTRIBUTING.md`, `CLAUDE.md`, `README.md`, `CHANGELOG.md`.
- Uses the existing `VSCE_PAT` secret. Both new jobs need `contents: write`: one to push tags, the other to create GitHub releases.
