# Spec Delta

## ADDED Requirements

### Requirement: Read pause before leaving typed text
Before the view leaves what replay just typed, replay SHALL wait until at least `agentTypewriter.readPauseSeconds` seconds (default 1.5, clamped to 0 to 15) have passed since replay last changed a mirror's text. The view leaves when replay brings an off-screen edit in the same mirror into view, or switches to another file's mirror. The read pause MUST NOT change any mirror's text.

#### Scenario: Next edit off-screen in the same file
- **WHEN** `readPauseSeconds` is 3, a change edits line 3 and line 350 of a 400-line file, and line 350 is not in view after the first edit
- **THEN** about 3 s pass between the last character typed on line 3 and the view starting to move toward line 350

#### Scenario: Switching files
- **WHEN** `readPauseSeconds` is 3 and a change to `b.ts` is queued right behind a change to `a.ts`
- **THEN** the `a.ts` mirror stays in view for about 3 s after its last character is typed, then the `b.ts` mirror is shown

#### Scenario: Edit already in view
- **WHEN** the next edit in the same file is in view
- **THEN** replay does not wait for the read pause before moving the caret there

#### Scenario: Scrolled into view during a pause
- **WHEN** playback is paused during the read pause before an off-screen edit, the user scrolls the edit's line into view, and playback resumes
- **THEN** the view does not move and only the caret moves

#### Scenario: Rename
- **WHEN** a change to `a.ts` is followed by a rename of `b.ts` to `c.ts`
- **THEN** the `a.ts` mirror stays in view for the read pause before the `b.ts` mirror is shown

#### Scenario: Turned off
- **WHEN** `readPauseSeconds` is 0
- **THEN** replay moves to off-screen edits and other files without waiting for the read pause

#### Scenario: Out of range
- **WHEN** `readPauseSeconds` is 40
- **THEN** the read pause is 15 s

### Requirement: Time already passed counts toward the read pause
The read pause SHALL count all time since replay last changed a mirror's text, including time spent waiting for the next change to be recorded and time spent paused. Replay SHALL wait only for whatever part of the read pause is left, and not at all once it has passed.

#### Scenario: Next change arrives late
- **WHEN** `readPauseSeconds` is 3, replay finishes a change to `a.ts`, and the next change, to `b.ts`, is recorded 10 s later
- **THEN** the `b.ts` mirror is shown without a further read pause

#### Scenario: Next change arrives soon
- **WHEN** `readPauseSeconds` is 3, replay finishes a change to `a.ts`, and the next change, to `b.ts`, is recorded 1 s later
- **THEN** the `a.ts` mirror stays in view about 2 s more before the `b.ts` mirror is shown

#### Scenario: Paused after typing
- **WHEN** playback is paused right after a change to `a.ts` finishes, for 5 s, and then resumed with a change to `b.ts` queued
- **THEN** the `b.ts` mirror is shown without a further read pause

### Requirement: No read pause after a jump in playback
Replay SHALL NOT wait for the read pause for the first change played, or for the first change played after a seek, replay from, skip to next, skip to latest, catch up, clear, following another lane by hand, or loading a session. Once finish current is pressed, replay SHALL end any read pause at once.

#### Scenario: After a seek
- **WHEN** the user seeks to an earlier change in another file right after a change finished typing
- **THEN** that change's mirror is shown without a read pause

#### Scenario: Finish current during the read pause
- **WHEN** the user presses finish current while replay waits to scroll to an off-screen edit
- **THEN** the edit is brought into view at once and the rest of the change appears

### Requirement: File-switch delay
After replay switches to another file's mirror and shows it, replay SHALL wait `agentTypewriter.fileSwitchDelayMs` ms (default 1000, clamped to 0 to 15000) before the first edit there, divided by the playback speed multiplier, and at most 15 s however slow the speed. The first change played SHALL NOT wait for it.

#### Scenario: Default delay
- **WHEN** `readPauseSeconds` and `fileSwitchDelayMs` are at their defaults, playback speed is 1x, and a change to `b.ts` is queued right behind a change to `a.ts`
- **THEN** the `a.ts` mirror stays in view about 1.5 s, then the `b.ts` mirror is shown about 1 s before its first edit

#### Scenario: Out of range
- **WHEN** `fileSwitchDelayMs` is 60000
- **THEN** the file-switch delay is 15 s

#### Scenario: Slow playback
- **WHEN** `fileSwitchDelayMs` is 15000 and the manual speed is 0.5x
- **THEN** the file-switch delay is 15 s

### Requirement: Deprecated scroll pause setting is honored
For each settings layer (workspace settings, the repository file, user settings), when that layer sets `scrollPauseMs` but not `readPauseSeconds`, the layer's read pause SHALL be its `scrollPauseMs` value divided by 1000. Layers SHALL keep their usual priority. The extension SHALL NOT rewrite either setting, and SHALL note the deprecation in its output channel once each time it starts to apply.

#### Scenario: Only the old setting is set
- **WHEN** the user settings set `scrollPauseMs` to 800 and no layer sets `readPauseSeconds`
- **THEN** the read pause is 0.8 s, before off-screen scrolls and file switches alike

#### Scenario: Both settings in the same layer
- **WHEN** the workspace settings set `scrollPauseMs` to 800 and `readPauseSeconds` to 5
- **THEN** the read pause is 5 s

#### Scenario: New setting in a higher layer
- **WHEN** the user settings set `scrollPauseMs` to 800 and the workspace settings set `readPauseSeconds` to 2
- **THEN** the read pause is 2 s

## MODIFIED Requirements

### Requirement: Scroll to the next edit in the same file
When replay is about to edit a line outside the viewport of the mirror it is already typing in, it SHALL wait for the read pause, then scroll there in eased steps at about `agentTypewriter.scrollLinesPerSecond` lines per second, instead of jumping. An edit already in view SHALL NOT move the view. Scrolling MUST NOT change the mirror's text.

#### Scenario: Next hunk far below
- **WHEN** a change edits line 3 and line 350 of a 400-line file, and line 350 is not in view after the first edit
- **THEN** replay waits for the read pause, then the view scrolls down through several positions until line 350 is in view, then the second edit is typed

#### Scenario: Next change to the same file
- **WHEN** a change to `a.ts` finishes with the view at its top, and the next change edits line 300 of `a.ts`
- **THEN** the view scrolls to line 300 instead of jumping

#### Scenario: Edit already in view
- **WHEN** the next edit's line is in view
- **THEN** the view does not move and only the caret moves

#### Scenario: Text unchanged by scrolling
- **WHEN** a change with hunks far apart finishes playing
- **THEN** the mirror's text equals the change's after text

### Requirement: File switches jump
The first edit after replay switches to another file, or of the first change played, SHALL be brought into view without the read pause or a scroll, after the file-switch delay. The same SHALL hold for the first edit of a rename, in the mirror for the new name. The read pause for a switch SHALL come before the other file's mirror is shown.

#### Scenario: Switching files
- **WHEN** a change to `a.ts` is followed by a change to line 300 of `b.ts`
- **THEN** after the read pause the `b.ts` mirror is shown, and after the file-switch delay it shows line 300 at once

#### Scenario: Rename with an edit
- **WHEN** a change to `a.ts` is followed by a rename of `a.ts` to `c.ts` that also edits line 300
- **THEN** once the `c.ts` mirror is shown it shows line 300 at once, with no read pause and no scroll

### Requirement: Scrolling follows playback speed and controls
The read pause and the scroll's duration SHALL be divided by the playback speed multiplier (manual speed times catch-up). A change of speed during the read pause SHALL apply to what is left of it. Pausing playback SHALL hold a scroll where it is until playback resumes. Seek, skip to next, and skip to latest SHALL stop a read pause or a scroll at once. Finish current SHALL end a read pause or a scroll by bringing the edit into view at once.

#### Scenario: Double speed
- **WHEN** the manual speed is 2x and no changes are queued
- **THEN** the read pause and the scroll each take half as long as at 1x

#### Scenario: Faster during the read pause
- **WHEN** `readPauseSeconds` is 6, replay waits to switch files at 1x, and the user picks 2x 1 s after the last edit
- **THEN** the switch happens about 3 s after the last edit, not 6 s

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
With `agentTypewriter.smoothScroll` set to `false`, replay SHALL bring every edit into view at once instead of scrolling. An off-screen edit SHALL still wait for the read pause first.

#### Scenario: Turned off
- **WHEN** `smoothScroll` is `false` and the next edit in the same file is 300 lines below the view
- **THEN** replay waits for the read pause, then the view jumps to the edit
