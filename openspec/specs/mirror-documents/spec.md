# mirror-documents Specification

## Purpose
Defines how the `agent-typewriter:` mirror documents represent the real files they replay, so a mirror looks like the file it stands in for without the real file ever being touched.

## Requirements

### Requirement: Mirror uses the recorded line ending
When a change is played, its mirror document SHALL use the line ending the real file had when that change was recorded, LF or CRLF. This SHALL hold regardless of VS Code's default line ending setting.

#### Scenario: CRLF file
- **WHEN** a file whose line breaks are all CRLF is modified and the change is played
- **THEN** the mirror document's line ending is CRLF while the change is typed and afterward

#### Scenario: LF file with a CRLF default
- **WHEN** VS Code's default line ending (`files.eol`) is CRLF
- **AND** a new file whose line breaks are LF is created and the change is played
- **THEN** the mirror document's line ending is LF

### Requirement: Line ending is captured at record time
The line ending used for a change SHALL be the one detected when the change is recorded, never when it is played. A file with mixed line endings SHALL count as CRLF only when CRLF breaks outnumber LF-only breaks. A file with no line breaks SHALL count as LF.

#### Scenario: File converted later
- **WHEN** a change to a CRLF file is recorded
- **AND** the real file is converted to LF before that change is played
- **THEN** the change is still played into a CRLF mirror

#### Scenario: Mixed line endings
- **WHEN** a file has three CRLF breaks and one LF-only break
- **THEN** its changes are played into a CRLF mirror

### Requirement: Replay result is independent of line ending
After a change is played, the mirror's text with line endings normalized SHALL equal the recorded after text. Each edit SHALL appear at the same line and column as it would in an LF mirror.

#### Scenario: Edit in the middle of a CRLF file
- **WHEN** a line is changed in the middle of a 50-line CRLF file and the change is played
- **THEN** the typed text appears on that line and column
- **AND** after playback the mirror contains exactly the after text with CRLF line breaks

#### Scenario: Snap to latest on a CRLF file
- **WHEN** "snap to latest" runs while a CRLF file's mirror is open
- **THEN** the mirror shows the newest recorded text with CRLF line breaks

### Requirement: Line-ending-only changes are not replayed
A write that changes only a file's line endings SHALL NOT be recorded as a change. The mirror SHALL use the new line ending from the next recorded change to that file.

#### Scenario: File converted from LF to CRLF
- **WHEN** an LF file is rewritten as CRLF with no other changes
- **THEN** no change is added to the timeline
- **AND** when a later content change to that file is played, the mirror uses CRLF

### Requirement: Mirror tabs survive a restart
When VS Code reopens a mirror tab after a reload or restart and the restored timeline has a change for that file, the tab SHALL open without a "file not found" error. It SHALL show the after text of the file's newest played change or, when none of its changes were played, the before text of its earliest queued change, with that change's recorded line ending.

#### Scenario: Played file left open
- **WHEN** a change to `a.ts` is played, its mirror tab is left open, and VS Code is restarted
- **THEN** the restored `a.ts` mirror tab opens and shows that change's after text

#### Scenario: Queued file left open
- **WHEN** a change to `b.ts` is played, a second change to `b.ts` is recorded while playback is paused, its mirror tab is left open, and the window is reloaded
- **THEN** the restored `b.ts` mirror tab shows the second change's before text
- **AND** resuming playback types the second change into it

#### Scenario: Played delete
- **WHEN** the newest played change to `c.ts` deleted it, its mirror tab is left open, and the window is reloaded
- **THEN** the restored `c.ts` mirror tab opens empty

#### Scenario: CRLF file
- **WHEN** a played change's file used CRLF line breaks and its mirror tab is left open across a reload
- **THEN** the restored mirror tab's line ending is CRLF

### Requirement: Mirror tabs without history are closed
After a reload or restart, a restored mirror tab whose file has no change in the restored timeline SHALL be closed rather than left showing an error, as SHALL a restored compare tab with such a mirror on either side. Tabs for the user's real files SHALL NOT be affected.

#### Scenario: History turned off
- **WHEN** `persistHistory` is off, a mirror tab is open, and the window is reloaded
- **THEN** the mirror tab is closed
- **AND** tabs for real files stay open

#### Scenario: File aged out of the history limit
- **WHEN** a mirror tab is open for a file whose changes are all older than the newest `historyLimit` changes, and the window is reloaded
- **THEN** that mirror tab is closed and mirror tabs for files still in the timeline are restored

#### Scenario: Compare tab with a mirror side
- **WHEN** a compare tab between a mirror and a real file is open, the mirror's file has no change in the restored timeline, and the window is reloaded
- **THEN** the compare tab is closed

### Requirement: A rename moves the mirror document
Playing a `rename` change SHALL show the old path's mirror with the change's before text, then open the new path's mirror with that text in the same column, close the old mirror's tabs, and remove the old mirror document. Any difference between the before and after text SHALL then be typed into the new mirror like a modify. Real files SHALL NOT be touched.

#### Scenario: Plain rename plays
- **WHEN** a rename from `src/a.ts` to `src/b.ts` plays
- **THEN** the `src/b.ts` mirror shows the file's text, and no tab or mirror document for `src/a.ts` remains

#### Scenario: Rename with an edit plays
- **WHEN** a rename whose after text adds a line plays
- **THEN** the mirror moves first and the added line is then typed into the new mirror

### Requirement: Renamed-away mirrors stay gone
Skipping to latest and refilling mirrors after a reload SHALL leave no mirror at a path whose newest change renamed it away.

#### Scenario: Skip to latest past a rename
- **WHEN** a rename from `a.ts` to `b.ts` is queued and the user skips to latest
- **THEN** the `b.ts` mirror shows the after text and no `a.ts` mirror remains

#### Scenario: Played rename across a reload
- **WHEN** a rename from `a.ts` to `b.ts` was played and the window is reloaded with both names' tabs restored
- **THEN** the `b.ts` tab shows the after text and the `a.ts` tab is closed

#### Scenario: Queued rename across a reload
- **WHEN** a rename from `a.ts` to `b.ts` is queued and the `a.ts` mirror tab is open across a reload
- **THEN** the `a.ts` tab shows the rename's before text, and resuming playback moves it to `b.ts`
