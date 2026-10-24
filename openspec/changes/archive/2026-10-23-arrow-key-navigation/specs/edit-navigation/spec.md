# Spec Delta

## MODIFIED Requirements

### Requirement: Scroll to the next edit in the same file
When replay is about to edit a line of the mirror it is already typing in, and that line is outside the editor's viewport, it SHALL first pause for `agentTypewriter.scrollPauseMs` milliseconds, then scroll the view in steps until the line is in view, instead of jumping. The scroll SHALL ease in and out and move at about `agentTypewriter.scrollLinesPerSecond` lines per second. An edit whose line is already in view SHALL NOT move the view; the caret SHALL reach it as described in "Arrow keys to nearby edits". Scrolling MUST NOT change the mirror's text.

#### Scenario: Next hunk far below
- **WHEN** a change edits line 3 and line 350 of a 400-line file, and line 350 is not in view after the first edit
- **THEN** replay pauses, then the view scrolls down through several positions until line 350 is in view, then the second edit is typed

#### Scenario: Next change to the same file
- **WHEN** a change to `a.ts` finishes with the view at its top, and the next change edits line 300 of `a.ts`
- **THEN** the view scrolls to line 300 instead of jumping

#### Scenario: Edit already in view
- **WHEN** the next edit's line is in view
- **THEN** the view does not move and only the caret moves

#### Scenario: Text unchanged by scrolling
- **WHEN** a change with hunks far apart finishes playing
- **THEN** the mirror's text equals the change's after text

## ADDED Requirements

### Requirement: Arrow keys to nearby edits
When the next edit in the same file and the caret are both in view, and the caret can reach the edit in at most 24 arrow-key presses, replay SHALL move the caret there one press at a time, at about `agentTypewriter.arrowKeysPerSecond` presses per second: a line per press, keeping its column, then by words and characters, or Home or End. Moving the caret MUST NOT change the mirror's text.

#### Scenario: Edit a few lines down
- **WHEN** the caret is at the end of line 2 after an edit, and the next edit is on line 12, both in view
- **THEN** the caret moves through each of lines 3 to 11 before reaching the edit on line 12

#### Scenario: Never inside a character
- **WHEN** the caret walks across a line with emoji
- **THEN** it never stops between the two halves of a surrogate pair

### Requirement: Far edits are clicked
When an edit cannot be reached by arrow keys as above, including after a scroll and for the first edit after a file switch, replay SHALL place the caret at the edit at once.

#### Scenario: Edit far away
- **WHEN** the next edit in view is 30 lines from the caret
- **THEN** the caret is placed at the edit at once

#### Scenario: Edit out of view
- **WHEN** the next edit needed a scroll to come into view
- **THEN** after the scroll the caret is placed at the edit at once

### Requirement: Arrow keys follow playback speed and controls
The time between presses SHALL be divided by the playback speed multiplier (manual speed times catch-up). Pausing playback SHALL hold the caret where it is until playback resumes. Seek, skip to next, and skip to latest SHALL stop the walk at once. Finish current SHALL place the caret at the edit at once and finish the change.

#### Scenario: Pause mid-walk
- **WHEN** playback is paused while the caret is walking to an edit
- **THEN** the caret stops moving and the change stays playing
- **WHEN** playback resumes
- **THEN** the caret continues to the edit and it is typed

#### Scenario: Double speed
- **WHEN** the manual speed is 2x and no changes are queued
- **THEN** presses come twice as fast as at 1x

### Requirement: Arrow navigation can be turned off
With `agentTypewriter.arrowNavigation` set to `false`, replay SHALL place the caret at every edit at once.

#### Scenario: Turned off
- **WHEN** `arrowNavigation` is `false` and the next edit is six lines below the caret, in view
- **THEN** the caret goes straight to the edit without visiting the lines between
