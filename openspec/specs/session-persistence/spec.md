# session-persistence Specification

## Purpose
Keeps the recorded timeline beyond a single extension host lifetime, so recorded changes and their playback state survive reloads and can later be saved and loaded as session files.

## Requirements

### Requirement: Timeline survives a reload
With `agentTypewriter.persistHistory` on (the default), the recorded timeline SHALL be kept in VS Code's storage for the workspace and restored when the extension activates in the same workspace. Each restored change SHALL keep the before and after text, path, kind, line ending and time it was recorded with.

#### Scenario: Reload after recording
- **WHEN** changes to `a.ts` and `b.ts` are recorded and played, and the window is reloaded
- **THEN** the panel lists the same changes in the same order
- **AND** Replay Entire Buffer types them again, ending with each mirror matching the recorded after text

#### Scenario: Different workspace
- **WHEN** changes are recorded in workspace A and VS Code opens workspace B
- **THEN** workspace B starts with its own saved timeline, or an empty one

### Requirement: Playback position survives a reload
A restored timeline SHALL keep which changes were played and which were pending. When any restored change is pending, playback SHALL start paused, and resuming SHALL play the pending changes in order.

#### Scenario: Reload with queued changes
- **WHEN** three changes are recorded while playback is paused, and the window is reloaded
- **THEN** the three changes are listed as pending and nothing is typed
- **AND** the status bar shows playback paused with three queued
- **AND** resuming types the three changes in recorded order

#### Scenario: Reload with everything played
- **WHEN** every recorded change has been played and the window is reloaded
- **THEN** every restored change is listed as played and playback is not paused

### Requirement: Restore respects the history limit
A restored timeline SHALL hold at most `agentTypewriter.historyLimit` changes, keeping the newest.

#### Scenario: Limit lowered before reload
- **WHEN** 50 changes were saved and `historyLimit` is 10 at the next activation
- **THEN** the restored timeline holds the newest 10 changes

### Requirement: Saved history is bounded in size
The saved timeline SHALL be limited to 64 MB of change text. When the buffer holds more, only the newest changes that fit SHALL be saved, and the output channel SHALL say how many were left out.

#### Scenario: Buffer larger than the cap
- **WHEN** the buffer holds changes whose before and after text total more than 64 MB
- **THEN** after a reload only the newest changes that fit are restored
- **AND** the output channel says how many older changes were not saved

### Requirement: Saved sessions are versioned
The saved timeline SHALL use a session format that carries a format identifier and a version number. A saved timeline with a newer version than the extension supports, an unknown change kind, or missing or malformed fields SHALL NOT be restored. In that case the output channel SHALL say why, and recording and playback SHALL start normally with an empty buffer.

#### Scenario: Saved by a newer version
- **WHEN** the saved timeline's version is higher than the one this extension writes
- **THEN** nothing is restored and the output channel says it was saved by a newer version

#### Scenario: Damaged file
- **WHEN** the saved timeline cannot be decompressed or parsed
- **THEN** nothing is restored, the reason is logged, and the extension activates normally

### Requirement: Persistence can be turned off
Turning `agentTypewriter.persistHistory` off SHALL stop saving the timeline and SHALL delete the saved timeline for the workspace. Turning it back on SHALL save the current buffer.

#### Scenario: Turned off
- **WHEN** `persistHistory` is turned off and the window is reloaded
- **THEN** the timeline starts empty

### Requirement: History is stored outside the workspace
The saved timeline SHALL be written only to the extension's VS Code storage folder for the workspace. Nothing SHALL be written in the workspace or to the user's real files.

#### Scenario: Recording with persistence on
- **WHEN** changes are recorded and saved
- **THEN** `git status` in the workspace shows only the changes the user and the agent made

### Requirement: Save the buffer to a session file
The Save Session to File command SHALL write every change in the buffer, in order, with its recorded before and after text, path, kind, line ending and time, to the file the user picks, in the versioned session format. The save dialog SHALL start outside the workspace. With an empty buffer, the command SHALL say so and write nothing.

#### Scenario: Save a recorded run
- **WHEN** the buffer holds changes and the user saves a session to `~/run.json`
- **THEN** `~/run.json` holds those changes in order with their recorded text
- **AND** no file in the workspace is created or changed

#### Scenario: Empty buffer
- **WHEN** the buffer is empty and the user runs Save Session to File
- **THEN** a message says the buffer is empty and no dialog opens

### Requirement: Load a session file into the buffer
The Load Session from File command SHALL read a session file, as written by Save Session to File or gzip-compressed, and replace the buffer with its changes. When the buffer is not empty, it SHALL ask before replacing it. After loading, every loaded change SHALL be pending and playback SHALL be paused at the first one, so resuming plays the session from the start.

#### Scenario: Load and play a saved run
- **WHEN** the user loads a session file saved earlier and resumes playback
- **THEN** the changes play in the saved order, and each mirror ends with the saved after text
- **AND** the user's real files are not modified

#### Scenario: Buffer not empty
- **WHEN** the buffer holds changes and the user picks a session file
- **THEN** the user is asked to confirm replacing the buffer, and declining leaves the buffer unchanged

### Requirement: Invalid session files are refused
A file that is not a session, is damaged, or was saved by a newer version SHALL NOT be loaded. An error message SHALL say why, and the buffer and playback SHALL stay as they were.

#### Scenario: Not a session file
- **WHEN** the user picks a JSON file that is not a session
- **THEN** an error says the file is not an Agent Typewriter session and the buffer is unchanged

#### Scenario: Newer version
- **WHEN** the user picks a session file with a version this extension does not read
- **THEN** an error says it was saved by a newer version and the buffer is unchanged

### Requirement: Large sessions and the history limit
When a session file holds more changes than `agentTypewriter.historyLimit`, loading it from the dialog SHALL let the user either raise `historyLimit` to the session's size and load every change, or load only the newest changes that fit.

#### Scenario: Raise the limit
- **WHEN** `historyLimit` is 500, the session holds 800 changes, and the user chooses to raise the limit
- **THEN** `historyLimit` becomes 800 and all 800 changes are loaded

#### Scenario: Load the newest
- **WHEN** the user chooses to load only what fits
- **THEN** the newest 500 changes are loaded
