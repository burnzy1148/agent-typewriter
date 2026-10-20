# Spec Delta

## Purpose

Defines how the `agent-typewriter:` mirror documents represent the real files they replay, so a mirror looks like the file it stands in for without the real file ever being touched.

## ADDED Requirements

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
