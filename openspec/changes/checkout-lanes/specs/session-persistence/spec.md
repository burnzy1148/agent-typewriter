# Spec Delta

## MODIFIED Requirements

### Requirement: Playback position survives a reload
A restored timeline SHALL keep which changes were played and which were pending in every lane, and which lane was followed. When any restored change is pending, playback SHALL start paused, and resuming SHALL play the followed lane's pending changes in order.

#### Scenario: Reload with queued changes
- **WHEN** three changes are recorded while playback is paused, and the window is reloaded
- **THEN** the three changes are listed as pending and nothing is typed
- **AND** the status bar shows playback paused with three queued
- **AND** resuming types the three changes in recorded order

#### Scenario: Reload with everything played
- **WHEN** every recorded change has been played and the window is reloaded
- **THEN** every restored change is listed as played and playback is not paused

#### Scenario: Reload with two lanes
- **WHEN** the `feature` lane is followed with one change queued, the main lane has two changes queued, and the window is reloaded
- **THEN** `feature` is still followed with one queued, and the main lane still has two queued

### Requirement: Restore respects the history limit
A restored timeline SHALL hold at most `agentTypewriter.historyLimit` changes across all lanes, keeping the newest.

#### Scenario: Limit lowered before reload
- **WHEN** 50 changes were saved and `historyLimit` is 10 at the next activation
- **THEN** the restored timeline holds the newest 10 changes

#### Scenario: Limit counts every lane
- **WHEN** `historyLimit` is 10 and two lanes record 8 changes each
- **THEN** the buffer holds the newest 10 of the 16, whichever lanes they are in

### Requirement: Session format version 2 carries renames
Version 2 of the session format SHALL add the `rename` change kind, whose changes carry the old path as `fromUri` and `fromRelPath`. The extension SHALL read versions 1, 2 and 3, and SHALL write version 3.

#### Scenario: Version 1 file
- **WHEN** a session saved before renames were recorded (version 1) is loaded
- **THEN** its changes load unchanged

#### Scenario: Rename round trip
- **WHEN** a buffer holding a rename is saved and loaded again
- **THEN** the loaded rename has the same old and new paths and text

### Requirement: Load a session file into the buffer
The Load Session from File command SHALL read a session file, as written by Save Session to File or gzip-compressed, and replace the buffer with its changes and lanes. When the buffer is not empty, it SHALL ask before replacing it. After loading, every loaded change SHALL be pending, the lane followed when the session was saved SHALL be followed, and playback SHALL be paused at its first change, so resuming plays the session from the start.

#### Scenario: Load and play a saved run
- **WHEN** the user loads a session file saved earlier and resumes playback
- **THEN** the changes play in the saved order, and each mirror ends with the saved after text
- **AND** the user's real files are not modified

#### Scenario: Buffer not empty
- **WHEN** the buffer holds changes and the user picks a session file
- **THEN** the user is asked to confirm replacing the buffer, and declining leaves the buffer unchanged

#### Scenario: Load a session with lanes
- **WHEN** the user loads a session saved with the `main` and `feature` lanes while `feature` was followed
- **THEN** both lanes are in the buffer with every change pending, `feature` is followed, and neither lane records until the user records those checkouts

## ADDED Requirements

### Requirement: Session format version 3 carries lanes
Version 3 of the session format SHALL add each change's lane, each lane's label, checkout path and color, a playback position per lane, and the followed lane. A version 1 or 2 session SHALL load as a single lane holding all its changes.

#### Scenario: Lanes round trip
- **WHEN** a buffer with changes in the `main` and `feature` lanes is saved and loaded again
- **THEN** each change is in the same lane, with the same label and color

#### Scenario: Version 2 file
- **WHEN** a session saved before lanes (version 2) is loaded
- **THEN** its changes load into one lane, and the Changes view lists them without a lane node
