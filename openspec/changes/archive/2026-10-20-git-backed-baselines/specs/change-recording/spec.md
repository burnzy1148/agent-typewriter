# Spec Delta

## ADDED Requirements

### Requirement: Baselines fit a memory budget
In-memory baselines SHALL be limited by `agentTypewriter.baselineBudgetMB` (default 256) of file size rather than by a file count. Files SHALL be snapshotted most recently modified first until the budget is spent. A file left without a baseline SHALL be logged in the output channel, and its first change SHALL only capture a baseline.

#### Scenario: More files than the old cap
- **WHEN** 8000 small files match the filters and they fit within the budget
- **THEN** every one of them gets a baseline, and a first change to any of them is replayed

#### Scenario: Budget exhausted
- **WHEN** the matching files exceed the budget
- **THEN** the most recently modified files get in-memory baselines first
- **AND** the output channel says how many files were left without a baseline

### Requirement: Optional git-backed baselines
With `agentTypewriter.gitBaselines` on (the default), a matching file that git reports as tracked and unmodified in its working tree SHALL get a baseline from git instead of an in-memory snapshot, without counting against the memory budget. On that file's first change, its before text SHALL be the file's content as git would check it out, with the repository's filters applied.

#### Scenario: First change to a clean tracked file
- **WHEN** `gitBaselines` is on and an agent edits a committed, unmodified file for the first time
- **THEN** the change is recorded with the committed text as its before text
- **AND** replay types only the agent's edit

#### Scenario: Modified or untracked files
- **WHEN** `gitBaselines` is on and a file is modified relative to the index, or untracked
- **THEN** it gets an in-memory snapshot within the budget, as with the setting off

#### Scenario: Setting off
- **WHEN** `gitBaselines` is off
- **THEN** git is never run and all baselines come from in-memory snapshots

### Requirement: Git use disables itself when git is unavailable
When `gitBaselines` is on and the `git` command is not installed or cannot run, git-backed baselines SHALL be turned off for the rest of the watching session with one output-channel message, and all baselines SHALL come from memory. A workspace folder outside a git repository SHALL use in-memory baselines only. Recording SHALL NOT fail in either case.

#### Scenario: Git is not installed
- **WHEN** `gitBaselines` is on and running `git` fails because it is not found
- **THEN** watching starts normally with in-memory baselines
- **AND** the output channel says git-backed baselines are off because git is unavailable, once

#### Scenario: Folder is not a repository
- **WHEN** `gitBaselines` is on and the workspace folder has no git repository
- **THEN** its files get in-memory baselines and watching starts normally

#### Scenario: Git cannot read a blob on first change
- **WHEN** reading a file's git baseline fails at its first change
- **THEN** that change only captures a baseline, as for a file without one, and the failure is logged

### Requirement: Git is read only
The extension SHALL only read from the watched repository. It SHALL NOT create commits, change the index, refs, stash or config, or write files in the repository.

#### Scenario: Watching a repository
- **WHEN** `gitBaselines` is on and the user records and replays changes
- **THEN** `git status` in that repository shows only the changes the user and the agent made

### Requirement: Toggling takes effect while watching
Changing `gitBaselines` or `baselineBudgetMB` while watching SHALL apply without restarting. Turning `gitBaselines` off SHALL replace git-backed baselines with in-memory snapshots read from disk, within the budget. Turning it on SHALL give git-backed baselines to clean tracked files that have none.

#### Scenario: Turn off while watching
- **WHEN** `gitBaselines` is turned off while watching, and an agent then edits a file that had a git-backed baseline
- **THEN** the change is recorded with the correct before text, provided the file fit the budget

#### Scenario: Turn on while watching
- **WHEN** `gitBaselines` is turned on while watching, and a clean tracked file had no baseline because the budget was spent
- **THEN** that file's first change is recorded and replayed
