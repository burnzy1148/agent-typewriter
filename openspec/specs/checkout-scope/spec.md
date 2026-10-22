# checkout-scope Specification

## Purpose
Defines which git checkout each workspace folder records from, so changes in a repository's other worktrees stay out of the timeline unless the user chooses to watch one of them.

## Requirements

### Requirement: A folder records only its own checkout by default
When a workspace folder is in a git repository and the user has not chosen another checkout for it, a path inside another worktree of that repository SHALL NOT be recorded or given a baseline, even when the worktree sits inside the folder. This SHALL apply in addition to the extension, exclude, include, and gitignore filters.

#### Scenario: Write in a nested worktree
- **WHEN** the main checkout is open, recording is on, a worktree of the same repository exists at `.claude/worktrees/feature`, and an agent writes `.claude/worktrees/feature/src/a.ts`
- **THEN** no change is recorded for it

#### Scenario: Write in the folder's own checkout
- **WHEN** the same setup holds and an agent writes `src/a.ts` in the main checkout
- **THEN** the change is recorded as before

#### Scenario: No baselines for nested worktrees
- **WHEN** recording starts in a main checkout that contains three nested worktrees
- **THEN** none of the files inside those worktrees get a baseline or count against the baseline budget

### Requirement: Worktrees are what git lists
A directory SHALL count as another checkout exactly when git lists it as a worktree of the folder's repository. A submodule, or a nested repository that is not a worktree of the folder's repository, SHALL NOT be treated as another checkout.

#### Scenario: Submodule
- **WHEN** the folder's repository has a submodule at `vendor/lib` and a file in it is written
- **THEN** the change is recorded if it passes the other filters

#### Scenario: Unrelated nested repository
- **WHEN** a separate repository has been cloned into `scratch/other` inside the folder and a file in it is written
- **THEN** the change is recorded if it passes the other filters

### Requirement: Worktree changes apply while recording
Adding or removing a worktree of the folder's repository while recording SHALL take effect without restarting. A worktree added inside the folder SHALL stop being recorded. Removing a worktree SHALL NOT affect changes already in the timeline.

#### Scenario: Agent creates a worktree while recording
- **WHEN** recording is on in the main checkout and an agent runs `git worktree add .worktrees/fix`, then writes files there
- **THEN** no changes are recorded for files under `.worktrees/fix`

### Requirement: Choosing a checkout
The user SHALL be able to choose, per workspace folder, which checkout of its repository is recorded: the folder's own checkout or any other worktree git lists, whether inside the folder or elsewhere on disk. The choice SHALL list each checkout with its branch, or its short commit when detached, and its path. While another checkout is chosen, only that checkout SHALL be recorded for the folder.

#### Scenario: Watch a sibling worktree
- **WHEN** the main checkout is open, a worktree exists at `../repo-feature`, the user chooses it, and an agent writes `src/a.ts` in it
- **THEN** the change is recorded and replayed
- **AND** writes to `src/a.ts` in the main checkout are not recorded

#### Scenario: Watch a nested worktree
- **WHEN** the user chooses the worktree at `.claude/worktrees/feature` and an agent writes `src/a.ts` in it
- **THEN** the change is recorded with the path `src/a.ts` relative to that worktree, labelled with the worktree's name

#### Scenario: Filters apply within the chosen checkout
- **WHEN** the include filter is `src/**` and the user has chosen another worktree
- **THEN** only files under that worktree's `src/` are recorded

#### Scenario: Multi-root workspace
- **WHEN** two workspace folders are open, each in a git repository with more than one worktree, and the user runs the command
- **THEN** the user first picks which folder the choice is for

### Requirement: The chosen checkout is shown
While recording, the status bar and the timeline view SHALL show which checkout is being recorded when it is not the folder's own. Selecting the status bar entry SHALL offer the checkout choice.

#### Scenario: Another worktree chosen
- **WHEN** recording is on with the worktree on branch `feature` chosen
- **THEN** the status bar shows `feature` as the watched checkout

### Requirement: Switching checkouts applies while recording
Choosing a different checkout while recording SHALL take effect without restarting. Files in the new checkout SHALL get baselines so their next change is recorded, files in the previous one SHALL stop being recorded, and changes already in the timeline SHALL stay as they are.

#### Scenario: Switch while changes are queued
- **WHEN** recording is on, two changes from the main checkout are queued, and the user chooses another worktree
- **THEN** the two queued changes are still played
- **AND** the next change in the chosen worktree is recorded as a modify from its baseline

### Requirement: Changes from different checkouts never share a mirror
A change recorded from a checkout other than the folder's own SHALL be shown and replayed under a path prefixed with that worktree's folder name, so the same file in two checkouts replays into two different mirror documents.

#### Scenario: Same file in two checkouts
- **WHEN** a change to `src/a.ts` is recorded in the main checkout, the user then chooses the worktree `feature`, and a change to its `src/a.ts` is recorded
- **THEN** the timeline lists them as `src/a.ts` and `feature/src/a.ts`
- **AND** each is replayed into its own mirror document

### Requirement: The choice is remembered
The chosen checkout SHALL be remembered per workspace folder across window reloads. If the remembered worktree no longer exists when recording starts or while recording, the folder SHALL record its own checkout instead and the output channel SHALL say so.

#### Scenario: Reload
- **WHEN** the user chooses a worktree, reloads the window, and starts recording
- **THEN** the chosen worktree is recorded

#### Scenario: Chosen worktree removed
- **WHEN** the chosen worktree is removed with `git worktree remove` while recording
- **THEN** recording continues in the folder's own checkout
- **AND** the output channel reports the fallback

### Requirement: Without git there is one checkout
When git cannot run, or a workspace folder is not in a git repository, the folder SHALL record as it did before this change, and choosing a checkout SHALL report that the folder has no other checkouts. The extension SHALL only read git state and SHALL NOT create, remove, or modify worktrees.

#### Scenario: Folder outside a repository
- **WHEN** the folder is not in a git repository and the user runs the command
- **THEN** a message says there are no other checkouts and recording is unchanged

#### Scenario: Git is read only
- **WHEN** the user chooses checkouts and records in them
- **THEN** `git worktree list` shows the same worktrees as before
