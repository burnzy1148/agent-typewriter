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
