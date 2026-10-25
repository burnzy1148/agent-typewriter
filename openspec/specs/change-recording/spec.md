# change-recording Specification

## Purpose
Defines how writes to files in the workspace become change events in the timeline, so that replay follows the order in which files were actually written on every operating system.

## Requirements

### Requirement: Changes are ordered by write time
The timeline SHALL order changes by when each file was written, not by when the file watcher reported them. The write time of a create or modify SHALL be the file's modification time when the change is recorded, and the write time of a delete SHALL be when its first watcher event arrived.

#### Scenario: Watcher reports two files in the opposite order
- **WHEN** `a.ts` is written before `b.ts`, both within one reorder window, and the watcher reports `b.ts` first
- **THEN** the timeline lists the change to `a.ts` before the change to `b.ts`
- **AND** replay types `a.ts` before `b.ts`

#### Scenario: Recorded time is the write time
- **WHEN** a modify is recorded whose file was last written at time T
- **THEN** the change's recorded time is T, not the time the change was processed

### Requirement: Changes are held for a reorder window
A recorded change SHALL NOT be added to the timeline until the reorder window has passed since its write time. Held changes SHALL then be added in write-time order, so a change reported late but written earlier still lands before them.

#### Scenario: Change appears after the window
- **WHEN** the reorder window is 250 ms and a file is written
- **THEN** its change is not in the timeline before 250 ms after the write
- **AND** it is in the timeline shortly after that, without further writes

#### Scenario: Window of zero
- **WHEN** `agentTypewriter.reorderWindowMs` is `0`
- **THEN** each change is added to the timeline as soon as it is read, as before this change

### Requirement: Reorder window setting
The setting `agentTypewriter.reorderWindowMs` SHALL accept `"auto"` or a number of milliseconds of zero or more. `"auto"`, the default, SHALL mean 2500 ms on Windows and 250 ms on other platforms. Any other value SHALL be treated as `"auto"`.

#### Scenario: Default on Windows
- **WHEN** the setting is not configured and VS Code runs on Windows
- **THEN** the reorder window is 2500 ms

#### Scenario: Default elsewhere
- **WHEN** the setting is not configured and VS Code runs on macOS or Linux
- **THEN** the reorder window is 250 ms

#### Scenario: Fixed value
- **WHEN** the setting is `1000`
- **THEN** the reorder window is 1000 ms on every platform

#### Scenario: Invalid value
- **WHEN** the setting is `-5` or `"fast"`
- **THEN** the reorder window is the `"auto"` value for the platform

### Requirement: Same-file changes keep their order
Two changes to the same file SHALL be added to the timeline in the order they were recorded, even when the later change has an earlier or equal write time.

#### Scenario: Modification time moves backward
- **WHEN** a file is changed, then changed again with its modification time set earlier than the first change's
- **THEN** the timeline lists the first change before the second

### Requirement: Held changes are released, not lost
Stopping recording and the catch-up command SHALL each add every held change to the timeline immediately, in write-time order, before they take effect.

#### Scenario: Stop while changes are held
- **WHEN** a change is being held and recording is stopped
- **THEN** the change is in the timeline after the stop

#### Scenario: Catch up while changes are held
- **WHEN** a change is being held and the user runs catch up
- **THEN** the change is added to the timeline and the mirror shows the file's latest recorded text

### Requirement: Own saves are recognized by content
With `agentTypewriter.ignoreOwnSaves` on, a change SHALL be skipped as the user's own only when the file's text on disk matches the text a VS Code editor save wrote to that file. Line endings SHALL NOT affect the match. How long ago the save happened SHALL NOT matter.

#### Scenario: Plain own save
- **WHEN** the user edits `a.ts` in an editor and saves it, and nothing else writes the file
- **THEN** no change is recorded for that save
- **AND** the next outside change to `a.ts` uses the saved text as its before text

#### Scenario: Outside write long after a save
- **WHEN** the user saves `a.ts`, and an agent writes `a.ts` 3 s later, past the old 2 s window
- **THEN** the agent's write is recorded as a change

#### Scenario: Setting off
- **WHEN** `ignoreOwnSaves` is off and the user saves `a.ts`
- **THEN** the save is recorded as a change, as before

### Requirement: Outside write right after a save is recorded
When the file's text on disk differs from what the latest editor save wrote, the recorder SHALL record a change whose before text is the saved text and whose after text is the disk text, even when both writes were merged into one debounced change.

#### Scenario: Agent writes right after the user's save
- **WHEN** the user's unsaved edit to `a.ts` is saved and an agent writes a different version of `a.ts` 50 ms later
- **THEN** exactly one change is recorded for `a.ts`
- **AND** its before text is the text the user saved and its after text is the agent's version
- **AND** replay types only the agent's edit

### Requirement: Save participants count as the user's
Text written by a save, including edits that save participants such as format on save make, SHALL count as the user's. When a change is read after a save starts but before it finishes, the recorder SHALL wait up to one second for the save to finish before comparing.

#### Scenario: Format on save
- **WHEN** the user saves `a.ts` and format on save rewrites part of it during the save
- **THEN** no change is recorded for that save

#### Scenario: Save never finishes
- **WHEN** a save starts and does not finish within one second of the change being read
- **THEN** the recorder compares against the text known when the save started

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

### Requirement: Renames are recorded as one change
When a recorded file is deleted and a recorded file is created with matching content while the first of the two is still held for reordering, the recorder SHALL record one change of kind `rename` instead of a delete and a create. The change SHALL name the new path, carry the old path, and keep the deleted text as its before text and the created text as its after text, both captured when the change is recorded. A create SHALL also pair with a delete held in a chosen worktree.

#### Scenario: Plain rename
- **WHEN** an agent renames `src/a.ts` to `src/b.ts` without changing it
- **THEN** the buffer gets one `rename` change from `src/a.ts` to `src/b.ts` whose before and after text are the file's text

#### Scenario: Rename with an edit
- **WHEN** an agent moves `src/a.ts` to `lib/a.ts` and changes one of its ten lines
- **THEN** the buffer gets one `rename` change whose before text is the old file and whose after text is the new file

#### Scenario: Rename in a chosen worktree
- **WHEN** a sibling worktree is chosen and an agent renames a file in it
- **THEN** the buffer gets one rename under the worktree's label, not a held delete and a create

### Requirement: Rename matching
Content SHALL match when it is identical, or when both texts are non-empty and at least half of the larger file's lines are unchanged. An identical match SHALL be preferred over a near one, then a file with the same name, then the nearest in write time. Only a create from nothing SHALL pair with a delete to nothing, and only changes the filters record SHALL pair. A half whose file already has a later change held SHALL NOT pair.

#### Scenario: Unrelated files
- **WHEN** an agent deletes `src/a.ts` and creates `src/c.ts` with different content in the same moment
- **THEN** the buffer gets a delete of `src/a.ts` and a create of `src/c.ts`

#### Scenario: Directory move
- **WHEN** an agent moves directory `src/util/` holding `x.ts` and an empty `index.ts` to `src/lib/`, next to another empty file being created
- **THEN** each moved file is one rename to its new path, and the empty `index.ts` pairs with `src/lib/index.ts`

#### Scenario: Moved across the filters
- **WHEN** the filters record `*.ts` and an agent renames `notes.txt` to `notes.ts`
- **THEN** the buffer gets a create of `notes.ts`
- **AND** renaming `notes.ts` back to `notes.txt` records a delete of `notes.ts`

#### Scenario: New file edited before the delete arrives
- **WHEN** the watcher reports the create of `src/b.ts` and an edit of it before the delete of `src/a.ts`, all within the reorder window
- **THEN** the buffer gets a create and the edit of `src/b.ts` and a delete of `src/a.ts`, and `src/b.ts` ends at the edited text

#### Scenario: Atomic replace
- **WHEN** an editor saves an existing file by writing a temporary file and renaming it over the original
- **THEN** the change to the original is recorded as a modify, as before

### Requirement: Git operations are not recorded
With `agentTypewriter.ignoreGitOperations` on, a write SHALL NOT be recorded when a git operation that brings in content from a commit made it: merge, pull, checkout or switch of a branch or commit, rebase, cherry-pick, revert, or reset to another commit. A write is git's only when that operation changed the path's index entry and the file agrees with the new entry. The written text SHALL become the file's baseline.

#### Scenario: Fast-forward merge
- **WHEN** recording is on and the user runs `git merge feature`, which fast-forwards and rewrites 40 files
- **THEN** no change is recorded for any of the 40 files
- **AND** an agent's next edit to one of them is recorded with the merged text as its before text

#### Scenario: Branch switch
- **WHEN** the user runs `git switch other`, which changes, adds and removes files
- **THEN** no create, modify, delete or rename is recorded for those files

#### Scenario: Pull with a merge commit
- **WHEN** the user runs `git pull` and git merges the fetched commits into the checkout
- **THEN** no change is recorded for the files the merge wrote

#### Scenario: Rebase
- **WHEN** the user runs `git rebase main` and git applies three commits, rewriting files at each step
- **THEN** no change is recorded for the files any step wrote

#### Scenario: Chosen worktree
- **WHEN** a sibling worktree is recorded in its own lane and the user merges a branch in that worktree
- **THEN** no change is recorded in that lane for the files the merge wrote

### Requirement: Conflicted files are baselines and their resolutions are recorded
When a merge, rebase, cherry-pick, revert or pull stops on conflicts, the text git writes into each conflicted file SHALL become its baseline without being recorded. A later write that resolves the conflict SHALL be recorded as a modify from the conflicted text to the resolved text, under the same own-save rule as any other write. Aborting the operation SHALL count as a git operation.

#### Scenario: Agent resolves a merge conflict
- **WHEN** `git merge feature` stops with a conflict in `a.ts` and an agent then rewrites `a.ts` without the conflict markers
- **THEN** no change is recorded for the merge's write of `a.ts`
- **AND** one modify is recorded for the agent's write, whose before text has the conflict markers and whose after text is the resolved file

#### Scenario: User resolves in an editor
- **WHEN** `ignoreOwnSaves` is on, a merge stops with a conflict in `a.ts`, and the user resolves it in a VS Code editor and saves
- **THEN** no change is recorded for the save
- **AND** an agent's next edit to `a.ts` is recorded with the user's resolved text as its before text

#### Scenario: Choosing a side
- **WHEN** a merge stops with a conflict in `a.ts` and the user runs `git checkout --theirs a.ts`
- **THEN** a modify of `a.ts` from the conflicted text to the chosen side is recorded

#### Scenario: Merge aborted
- **WHEN** a merge stops with conflicts and the user runs `git merge --abort`
- **THEN** no change is recorded for the files the abort restores

#### Scenario: Rebase continues after a conflict
- **WHEN** an agent resolves a rebase conflict and runs `git rebase --continue`, and git applies the remaining commits
- **THEN** the resolution is recorded, and no change is recorded for the files the remaining commits wrote

### Requirement: Stash push and pop are not recorded
With `agentTypewriter.ignoreGitOperations` on, `git stash push` SHALL NOT record its writes that return files to the index, and `git stash pop` SHALL NOT record its writes to the paths the popped stash recorded. Their written text SHALL become the files' baselines.

#### Scenario: Stash, pull, pop
- **WHEN** the user has unstaged edits to `a.ts`, runs `git stash`, `git pull` and `git stash pop`
- **THEN** no change is recorded for `a.ts` or any file the pull wrote
- **AND** an agent's next edit to `a.ts` is recorded with the popped text as its before text

#### Scenario: Stash with untracked files
- **WHEN** the user runs `git stash -u` with an untracked `notes.ts`, then `git stash pop`
- **THEN** neither the removal nor the return of `notes.ts` is recorded

### Requirement: Edits during a git operation are recorded
A write whose path the operation did not change in the index, or whose text does not agree with git's result, SHALL be recorded as usual, even when it lands while a git operation runs. Git activity that changes no index entry, such as a `git status` refreshing the index, SHALL NOT keep any write from being recorded.

#### Scenario: Agent edits while the user merges
- **WHEN** an agent writes `b.ts` while `git merge feature` runs, and the merge does not touch `b.ts`
- **THEN** the agent's change to `b.ts` is recorded

#### Scenario: Background status refresh
- **WHEN** an agent writes `a.ts` back to its committed text and VS Code's git extension then refreshes the index
- **THEN** the agent's change to `a.ts` is recorded

#### Scenario: Agent overwrites a merged file
- **WHEN** a merge rewrites `a.ts` and an agent writes different text to `a.ts` before the recorder reads it
- **THEN** a modify of `a.ts` is recorded, with the agent's text as its after text

### Requirement: Discards and stash apply are recorded
Writes that return working-tree edits to the index without changing the index entry, such as `git restore <path>`, `git checkout -- <path>` or `git reset --hard` to the current commit, SHALL be recorded like any other edit. So SHALL the writes of `git stash apply`, which leaves the stash in place.

#### Scenario: Restore a file
- **WHEN** an agent edits `a.ts` and then runs `git restore a.ts`
- **THEN** the edit and the restore are both recorded, and replaying them ends with the committed text

#### Scenario: Stash apply
- **WHEN** the user runs `git stash apply`
- **THEN** the files it writes are recorded as changes

### Requirement: Git operation setting
The setting `agentTypewriter.ignoreGitOperations` SHALL default to on and SHALL apply while recording without a restart. With it off, outside a git repository, or when git cannot run, every write SHALL be recorded as before this requirement, and recording SHALL NOT fail. When git cannot run, the output channel SHALL say once that git operations are recorded.

#### Scenario: Setting off
- **WHEN** `ignoreGitOperations` is off and the user runs `git merge feature`
- **THEN** each file the merge wrote is recorded as a change

#### Scenario: Folder is not a repository
- **WHEN** the workspace folder has no git repository
- **THEN** every write is recorded as before

#### Scenario: Git becomes unavailable
- **WHEN** running `git` fails because it is not found while a write is being classified
- **THEN** the write is recorded
- **AND** the output channel says, once, that git operations are recorded because git is unavailable

#### Scenario: Turned on while recording
- **WHEN** `ignoreGitOperations` is turned on while recording and the user then switches branches
- **THEN** no change is recorded for the files the switch wrote
