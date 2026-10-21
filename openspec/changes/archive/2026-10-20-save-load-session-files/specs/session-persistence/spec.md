# Spec Delta

## ADDED Requirements

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
