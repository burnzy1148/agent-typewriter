# Spec Delta

## ADDED Requirements

### Requirement: Moves within a block typed outside in
When a block is typed outside in, moving the caret back to the end of its opening line to type the body, and past its closing line afterwards, SHALL NOT wait for the read pause or scroll. A target outside the view SHALL be brought into view at once, the way typing keeps the caret in view. In view, the caret SHALL reach it by arrow keys or a click as for any other edit.

#### Scenario: Back to the body
- **WHEN** `arrowNavigation` is on and replay has typed a block's opening line and its closing line, both in view
- **THEN** the caret walks up to the end of the opening line with arrow keys, without a read pause, and the body is typed there

#### Scenario: Past the closing line at the bottom of the view
- **WHEN** replay finishes a block's body on the last visible line, and more text follows the block's closing line in the same edit
- **THEN** that text is brought into view at once, without a read pause or a scroll, and typed

#### Scenario: Turned off
- **WHEN** `naturalOrder` is `false`
- **THEN** every move between edits follows the other requirements of this capability

## MODIFIED Requirements

### Requirement: Scroll to the next edit in the same file
When replay is about to edit a line outside the viewport of the mirror it is already typing in, it SHALL wait for the read pause, then scroll there in eased steps at about `agentTypewriter.scrollLinesPerSecond` lines per second, instead of jumping. An edit already in view SHALL NOT move the view. A move within a block typed outside in SHALL NOT scroll. Scrolling MUST NOT change the mirror's text.

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

### Requirement: Read pause before leaving typed text
Before the view leaves what replay just typed, replay SHALL wait until at least `agentTypewriter.readPauseSeconds` seconds (default 1.5, clamped to 0 to 15) have passed since replay last changed a mirror's text. The view leaves when replay brings an off-screen edit in the same mirror into view, other than a move within a block typed outside in, or switches to another file's mirror. The read pause MUST NOT change any mirror's text.

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
