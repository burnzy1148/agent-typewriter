# Spec Delta

## ADDED Requirements

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
