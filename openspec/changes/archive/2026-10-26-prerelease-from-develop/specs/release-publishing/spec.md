# Spec Delta

## Purpose

How the extension is versioned, tagged and published to the Visual Studio Code Marketplace on its two channels: stable releases cut through the Release workflow, and pre-releases that CI tags on each merge into `develop` and a maintainer publishes on demand.

## ADDED Requirements

### Requirement: Stable versions use even minors
`package.json` on `develop` SHALL hold the current stable version and SHALL NOT change when a pre-release is tagged or published. The Release workflow's `minor` bump SHALL produce the first even minor above the pre-release minor, with patch 0. `patch` SHALL increment the patch, and `major` SHALL produce the next major with minor and patch 0.

#### Scenario: Minor bump from an odd stable minor
- **WHEN** the stable version is 0.3.0 and the maintainer runs the Release workflow with `minor`
- **THEN** the bump PR sets the version to 0.6.0

#### Scenario: Minor bump from an even stable minor
- **WHEN** the stable version is 0.6.2 and the maintainer runs the Release workflow with `minor`
- **THEN** the bump PR sets the version to 0.8.0

#### Scenario: Patch and major bumps
- **WHEN** the stable version is 0.6.0
- **THEN** a `patch` bump gives 0.6.1 and a `major` bump gives 1.0.0

### Requirement: Pre-release version numbers
A pre-release version SHALL be `M.P.N`. `M` is the stable major and `P` is the first odd minor above the stable minor. `N` SHALL be one more than the highest `N` among existing `pre-vM.P.*` tags, or 0 when there are none. Every pre-release version SHALL therefore be higher than the stable version it follows and lower than the next minor or major stable release.

#### Scenario: First pre-release after 0.3.0
- **WHEN** the stable version is 0.3.0 and no `pre-v0.5.*` tag exists
- **THEN** the pre-release version is 0.5.0

#### Scenario: Next pre-release
- **WHEN** the stable version is 0.3.0 and tags `pre-v0.5.0` and `pre-v0.5.1` exist
- **THEN** the pre-release version is 0.5.2

#### Scenario: After a minor stable release
- **WHEN** the bump to 0.6.0 has merged into `develop` and a feature PR merges after it
- **THEN** the pre-release version is 0.7.0

#### Scenario: After a patch stable release
- **WHEN** the stable version moves from 0.6.0 to 0.6.1 and `pre-v0.7.3` exists
- **THEN** the next pre-release version is 0.7.4

### Requirement: Pre-release tag on each develop merge
When a push to `develop` changes the extension and CI's unit, integration and packaging checks pass, CI SHALL tag that commit `pre-v<version>`. Tagging SHALL publish nothing. A push that changes only the site, a version-bump merge, a failed run, or a commit that does not descend from the commit of the newest tag in its `M.P` stream SHALL get no tag. Tags SHALL rise along `develop`'s history.

#### Scenario: Feature merge
- **WHEN** a PR that changes `src/` is squash-merged into `develop` and CI passes
- **THEN** the merge commit is tagged with the next pre-release version, and nothing is published

#### Scenario: CI fails
- **WHEN** a test fails on the push to `develop`
- **THEN** that commit gets no tag

#### Scenario: Site-only merge
- **WHEN** a PR that changes only `site/` merges into `develop`
- **THEN** that commit gets no tag

#### Scenario: Version-bump merge
- **WHEN** the Release workflow's `bump/v<version>` PR merges into `develop`
- **THEN** that commit gets no `pre-v` tag

#### Scenario: Merges close together
- **WHEN** a second PR merges into `develop` before the first merge's CI run finishes, and that run is cancelled
- **THEN** the first merge gets no tag of its own, the second merge gets the next version, and its tag covers both

#### Scenario: Late run for an older commit
- **WHEN** a run for an older commit finishes after a newer commit has been tagged `pre-v0.5.4`
- **THEN** the older commit is not tagged

### Requirement: Pre-release tags
Pre-release tags SHALL use the `pre-v` prefix. They SHALL NOT start a stable publish or satisfy any check the stable release flow makes on `v<version>` tags, and SHALL NOT be deleted. A commit SHALL get at most one `pre-v` tag. A rerun of the tagging job for an already tagged commit SHALL keep the existing tag.

#### Scenario: Rerun tagging
- **WHEN** the tagging job is rerun for a commit tagged `pre-v0.5.2`
- **THEN** no `pre-v0.5.3` is created

#### Scenario: Stable flow ignores pre-release tags
- **WHEN** `pre-v0.5.2` exists and the maintainer releases 0.6.0
- **THEN** the bump, tag and publish steps of the stable release behave as if the pre-release tag did not exist

### Requirement: Publish a pre-release on demand
A maintainer SHALL be able to publish a pre-release by running a Pre-release GitHub Actions workflow. It takes an optional `pre-v` tag and defaults to the newest one. It SHALL publish that tag's commit to the Marketplace as a pre-release with the tag's version, and create a GitHub release marked as a pre-release with the `.vsix` attached. It SHALL publish nothing on its own schedule or on a push.

#### Scenario: Publish the newest build
- **WHEN** the newest tag is `pre-v0.5.4` and the maintainer runs the workflow without a tag
- **THEN** 0.5.4, built from the commit tagged `pre-v0.5.4`, is published as a pre-release, and GitHub release `pre-v0.5.4` is created with its `.vsix`

#### Scenario: Publish a chosen build
- **WHEN** the maintainer runs the workflow with tag `pre-v0.5.3`, and nothing higher than 0.5.2 is on the Marketplace
- **THEN** 0.5.3 is published from the commit tagged `pre-v0.5.3`

#### Scenario: Merges alone publish nothing
- **WHEN** PRs merge into `develop` and get `pre-v` tags, and nobody runs the workflow
- **THEN** the Marketplace and GitHub releases are unchanged

### Requirement: Publishing refuses builds that would not reach testers
The Pre-release workflow SHALL refuse, without publishing, a tag that does not start with `pre-v`, a tag whose commit is not in `develop`'s history, and a version not higher than every version on the Marketplace. Running it again for a version it already published SHALL finish any step that did not complete, and publish nothing new.

#### Scenario: Older than the Marketplace
- **WHEN** 0.5.4 is on the Marketplace and the maintainer runs the workflow with `pre-v0.5.3`
- **THEN** the run fails, saying 0.5.4 is already higher, and nothing is published

#### Scenario: Stable release overtook the build
- **WHEN** stable 0.6.0 is on the Marketplace and the maintainer runs the workflow with `pre-v0.5.6`
- **THEN** the run fails and nothing is published

#### Scenario: Not a pre-release tag
- **WHEN** the maintainer runs the workflow with `v0.3.0`
- **THEN** the run fails and nothing is published

#### Scenario: Rerun after a partial failure
- **WHEN** a run published 0.5.4 to the Marketplace but failed before creating the GitHub release, and the maintainer reruns it
- **THEN** the GitHub release is created and pruning runs, and the Marketplace gets no duplicate

### Requirement: Channels stay separate
Pre-release versions SHALL be published with the Marketplace pre-release flag, and stable versions without it. Users on the stable channel SHALL only ever be offered stable versions. On GitHub, the latest stable release SHALL stay marked "Latest".

#### Scenario: Stable user
- **WHEN** 0.5.4 is the newest pre-release and 0.3.0 the newest stable version
- **THEN** a user on the stable channel is offered 0.3.0 only

#### Scenario: Pre-release user reaches the next stable release
- **WHEN** a user on the pre-release channel has 0.5.4 and stable 0.6.0 is published
- **THEN** they are offered 0.6.0, and the next pre-release after it once one is published

### Requirement: Keep the newest 2 pre-releases
After publishing a pre-release, the Pre-release workflow SHALL remove all but the newest 2 pre-release versions from the Marketplace, and all but the newest 2 pre-release GitHub releases. It SHALL NOT remove any stable version or stable GitHub release, and SHALL NOT delete `pre-v` tags.

#### Scenario: Third pre-release
- **WHEN** pre-releases 0.5.0 and 0.5.3 are published and 0.5.4 is published next
- **THEN** 0.5.0 is removed from the Marketplace and its GitHub release is deleted, 0.5.3 and 0.5.4 remain, and tag `pre-v0.5.0` remains

#### Scenario: Stable versions untouched
- **WHEN** pruning runs while stable 0.3.0 and 0.2.0 are on the Marketplace
- **THEN** both stable versions remain

### Requirement: Stable release notes start at the previous stable release
The GitHub release created for a stable version SHALL generate its notes from the previous stable `v<version>` tag, not from a pre-release.

#### Scenario: Notes after pre-releases
- **WHEN** 0.6.0 is released after 0.3.0, with pre-releases between them
- **THEN** the 0.6.0 release notes list every change since `v0.3.0`
