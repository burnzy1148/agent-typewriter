# edit-navigation Specification

## Purpose
Defines how replay brings each edit into view and moves the caret to it before typing, so moving through a file looks like a person scrolling and navigating rather than jumping.

## Requirements

### Requirement: Scroll to the next edit in the same file
When replay is about to edit a line of the mirror it is already typing in, and that line is outside the editor's viewport, it SHALL first pause for `agentTypewriter.scrollPauseMs` milliseconds, then scroll the view in steps until the line is in view, instead of jumping. The scroll SHALL ease in and out and move at about `agentTypewriter.scrollLinesPerSecond` lines per second. An edit whose line is already in view SHALL only move the caret. Scrolling MUST NOT change the mirror's text.

#### Scenario: Next hunk far below
- **WHEN** a change edits line 3 and line 350 of a 400-line file, and line 350 is not in view after the first edit
- **THEN** replay pauses, then the view scrolls down through several positions until line 350 is in view, then the second edit is typed

#### Scenario: Next change to the same file
- **WHEN** a change to `a.ts` finishes with the view at its top, and the next change edits line 300 of `a.ts`
- **THEN** the view scrolls to line 300 instead of jumping

#### Scenario: Edit already in view
- **WHEN** the next edit's line is in view
- **THEN** the view does not move and only the caret is placed

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
