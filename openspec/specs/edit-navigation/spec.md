# edit-navigation Specification

## Purpose
Defines how replay brings each edit into view and moves the caret to it before typing, so moving through a file looks like a person scrolling and navigating rather than jumping.

## Requirements

### Requirement: Scroll to the next edit in the same file
When replay is about to edit a line outside the viewport of the mirror it is already typing in, it SHALL pause for `agentTypewriter.scrollPauseMs` ms, then scroll there in eased steps at about `agentTypewriter.scrollLinesPerSecond` lines per second, instead of jumping. An edit already in view SHALL NOT move the view. Scrolling MUST NOT change the mirror's text.

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

### Requirement: Long scrolls stay short
A scroll SHALL take at most one second at a playback speed of 1x. When the edit is more than two viewport heights away, the view SHALL jump to within two viewport heights of it and scroll the rest.

#### Scenario: Edit thousands of lines away
- **WHEN** the next edit is 5000 lines below the view
- **THEN** the view jumps most of the way and the visible scroll lasts at most one second

### Requirement: File switches jump
The first edit after replay switches to another file, or of the first change played, SHALL be brought into view without the pre-scroll pause or a scroll, after the file-switch delay.

#### Scenario: Switching files
- **WHEN** a change to `a.ts` is followed by a change to line 300 of `b.ts`
- **THEN** after the file-switch delay the `b.ts` mirror shows line 300 at once

### Requirement: Scrolling follows playback speed and controls
The pre-scroll pause and the scroll's duration SHALL be divided by the playback speed multiplier (manual speed times catch-up). Pausing playback SHALL hold a scroll where it is until playback resumes. Seek, skip to next, and skip to latest SHALL stop a scroll at once. Finish current SHALL end a scroll by bringing the edit into view at once.

#### Scenario: Double speed
- **WHEN** the manual speed is 2x and no changes are queued
- **THEN** the pre-scroll pause and the scroll each take half as long as at 1x

#### Scenario: Pause mid-scroll
- **WHEN** playback is paused while the view is scrolling to an edit
- **THEN** the view stops moving and the change stays playing
- **WHEN** playback resumes
- **THEN** the scroll continues and the edit is typed

#### Scenario: Finish current mid-scroll
- **WHEN** the user presses finish current while the view is scrolling to an edit
- **THEN** the edit's line is shown at once and the rest of the change appears

#### Scenario: Skip to latest mid-scroll
- **WHEN** the user skips to latest while the view is scrolling to an edit
- **THEN** the view stops scrolling and every mirror shows its newest recorded state

### Requirement: Smooth scrolling can be turned off
With `agentTypewriter.smoothScroll` set to `false`, replay SHALL bring every edit into view at once, with no pre-scroll pause.

#### Scenario: Turned off
- **WHEN** `smoothScroll` is `false` and the next edit in the same file is 300 lines below the view
- **THEN** the view jumps to the edit with no pause

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
