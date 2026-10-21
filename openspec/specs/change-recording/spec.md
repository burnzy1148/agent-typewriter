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
