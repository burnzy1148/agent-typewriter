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
A restored timeline SHALL hold at most `agentTypewriter.historyLimit` changes and at most `agentTypewriter.historySizeMB` of change text across all lanes, keeping the newest changes that fit both.

#### Scenario: Limit lowered before reload
- **WHEN** 50 changes were saved and `historyLimit` is 10 at the next activation
- **THEN** the restored timeline holds the newest 10 changes

#### Scenario: Limit counts every lane
- **WHEN** `historyLimit` is 10 and two lanes record 8 changes each
- **THEN** the buffer holds the newest 10 of the 16, whichever lanes they are in

#### Scenario: Size bound lowered before reload
- **WHEN** 20 MB of change text was saved and `historySizeMB` is 5 at the next activation
- **THEN** the restored timeline holds the newest changes that fit in 5 MB

### Requirement: Saved sessions are versioned
The saved timeline SHALL carry a format identifier and a version number. A saved timeline with a newer version than the extension supports, or whose state cannot be parsed as that format, SHALL NOT be restored and SHALL NOT be overwritten. In that case the output channel SHALL say why, and recording and playback SHALL start normally with an empty buffer. Session files SHALL keep the versioned session format, and a session file with a newer version, an unknown change kind (including `rename` in a version 1 file), or missing or malformed fields (including a rename without its old path) SHALL NOT be loaded.

#### Scenario: Saved by a newer version
- **WHEN** the saved timeline's version is higher than the one this extension writes
- **THEN** nothing is restored, the output channel says it was saved by a newer version, and the saved timeline is moved aside rather than replaced

#### Scenario: Damaged file
- **WHEN** a timeline saved by an earlier version, as one compressed file, cannot be decompressed or parsed
- **THEN** nothing is restored, the reason is logged, and the extension activates normally

#### Scenario: Damaged state
- **WHEN** the saved timeline's state cannot be parsed
- **THEN** its changes are restored as pending, the reason is logged, and the extension activates normally

### Requirement: Session format version 2 carries renames
Version 2 of the session format SHALL add the `rename` change kind, whose changes carry the old path as `fromUri` and `fromRelPath`. The extension SHALL read versions 1, 2 and 3, and SHALL write version 3.

#### Scenario: Version 1 file
- **WHEN** a session saved before renames were recorded (version 1) is loaded
- **THEN** its changes load unchanged

#### Scenario: Rename round trip
- **WHEN** a buffer holding a rename is saved and loaded again
- **THEN** the loaded rename has the same old and new paths and text

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
The Load Session from File command SHALL read a session file, as written by Save Session to File or gzip-compressed, and replace the buffer with its changes and lanes. When the buffer is not empty, or when watching, it SHALL ask first. After loading, every loaded change SHALL be pending, the lane followed when the session was saved (or, for a session without lanes, its one lane) SHALL be followed, and playback SHALL be paused at its first change, so resuming plays the session from the start.

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

### Requirement: Loading a session stops watching
When watching, Load Session from File SHALL stop watching, so live edits do not replay into the loaded session's mirrors, and its confirmation SHALL say so.

#### Scenario: Load while watching
- **WHEN** watching is on and the user loads a session saved before lanes
- **THEN** the confirmation says watching stops, watching stops, and resuming types the loaded changes from the first

### Requirement: Invalid session files are refused
A file that is not a session, is damaged, or was saved by a newer version SHALL NOT be loaded. An error message SHALL say why, and the buffer and playback SHALL stay as they were.

#### Scenario: Not a session file
- **WHEN** the user picks a JSON file that is not a session
- **THEN** an error says the file is not an Agent Typewriter session and the buffer is unchanged

#### Scenario: Newer version
- **WHEN** the user picks a session file with a version this extension does not read
- **THEN** an error says it was saved by a newer version and the buffer is unchanged

### Requirement: Large sessions and the history limit
When a session file holds more changes than `agentTypewriter.historyLimit` or more change text than `agentTypewriter.historySizeMB`, loading it from the dialog SHALL let the user either raise whichever limits it exceeds to fit the session and load every change, or load only the newest changes that fit both limits.

#### Scenario: Raise the limit
- **WHEN** `historyLimit` is 500, the session holds 800 changes, and the user chooses to raise the limits
- **THEN** `historyLimit` becomes 800 and all 800 changes are loaded

#### Scenario: Raise the size bound
- **WHEN** `historySizeMB` is 64, the session holds 100 MB of change text, and the user chooses to raise the limits
- **THEN** `historySizeMB` becomes 100 and every change is loaded

#### Scenario: Load the newest
- **WHEN** the user chooses to load only what fits
- **THEN** the newest changes that fit both limits are loaded

### Requirement: Highlight clears survive a reload
With `agentTypewriter.persistHistory` on, the saved timeline SHALL keep the highlight clears in effect, for all files and for single files, so highlights after a reload match those before it. A clear whose change was left out of the restored timeline SHALL be dropped. Timelines saved without this information SHALL restore with no clears. A loaded session file SHALL start with no highlights.

#### Scenario: Reload after clearing
- **WHEN** the user clears highlights, plays a change that adds a line to `a.ts`, and reloads the window
- **THEN** `a.ts`'s restored mirror highlights only that line

#### Scenario: Reload while a change is typing
- **WHEN** the user clears highlights while a change is being typed, and the window is reloaded before it finishes
- **THEN** after the reload and that change's replay, no file shows highlights from before the clear

#### Scenario: Timeline saved by an earlier version
- **WHEN** the saved timeline was written before this change
- **THEN** it restores normally, and each file is highlighted against the before text of its earliest change

#### Scenario: Load a session file
- **WHEN** the user loads a session file
- **THEN** every change is pending and no mirror shows highlights until changes play

### Requirement: Session format version 3 carries lanes
Version 3 of the session format SHALL add each change's lane, each lane's label, checkout path and color, a playback position per lane, and the followed lane. A version 1 or 2 session SHALL load as a single lane holding all its changes.

#### Scenario: Lanes round trip
- **WHEN** a buffer with changes in the `main` and `feature` lanes is saved and loaded again
- **THEN** each change is in the same lane, with the same label and color

#### Scenario: Version 2 file
- **WHEN** a session saved before lanes (version 2) is loaded
- **THEN** its changes load into one lane, and the Changes view lists them without a lane node

### Requirement: Saving writes only what changed
With `persistHistory` on, a save SHALL write the changes recorded since the previous save and a small record of the playback position, lanes and highlight clears. It SHALL NOT rewrite changes saved before, so the time a save takes does not grow with the buffer. Saves SHALL still happen at most every 2 seconds while the timeline changes, and once more when the extension deactivates.

#### Scenario: Playing a large buffer
- **WHEN** the buffer holds 60 MB of saved change text and a change is played
- **THEN** the next save writes the new playback position and no change text

#### Scenario: Recording into a large buffer
- **WHEN** the buffer holds 60 MB of saved change text and one 10 KB change is recorded
- **THEN** the next save writes that one change and the new state

### Requirement: Saved history follows the buffer
The saved timeline SHALL hold the changes in the buffer and no others. Changes that leave the buffer, through either bound, Clear Buffer, loading a session file or replaying git commits, SHALL be removed from the saved timeline, so that the disk space it uses stays within about the buffer's size bound plus a few megabytes per lane.

#### Scenario: Old changes fall off
- **WHEN** recording drops the oldest changes from a full buffer and the window is reloaded
- **THEN** the dropped changes are not restored, and the saved timeline's files hold no more than a few megabytes beyond the buffer's change text

#### Scenario: Buffer cleared
- **WHEN** the user clears the buffer and the window is reloaded
- **THEN** the timeline starts empty

### Requirement: Change text is read from the saved timeline when needed
With `persistHistory` on, once a change has been saved its text SHALL NOT stay in memory for the life of the buffer. It SHALL be read back from the saved timeline when the change is played, shown in a diff, or needed for highlights or a mirror's contents. The text read back SHALL be exactly the before and after text captured when the change was recorded, never the file as it is on disk at play time. With `persistHistory` off, the buffer's text SHALL stay in memory, within the size bound.

#### Scenario: File changed again before playback
- **WHEN** a change to `a.ts` is recorded and saved, `a.ts` is then rewritten on disk, and the change is played later
- **THEN** the mirror is typed from the recorded before text to the recorded after text

#### Scenario: Diff of an old change
- **WHEN** the user opens the diff of a change saved long ago
- **THEN** both sides show the text recorded for that change

### Requirement: Interrupted saves lose at most the unfinished changes
When the extension host stops in the middle of a save, the next activation SHALL restore every change whose save had completed, in order, with the playback position from the last completed save. A change whose text was only partly written SHALL be left out and the output channel SHALL say how many were left out. Later saves SHALL continue after the last complete change.

#### Scenario: Torn last change
- **WHEN** the window closes while the last recorded change is half written
- **THEN** after the next activation every earlier change is restored and the half-written one is not

#### Scenario: Recording after recovery
- **WHEN** a saved timeline with a torn last change was restored and more changes are recorded and saved
- **THEN** the next reload restores the earlier changes and the new ones, in order

### Requirement: History saved by an earlier version is migrated
A timeline saved by an earlier version of the extension, as one compressed file, SHALL be restored with its changes, playback position, lanes and highlight clears, then written in the current form and removed. If the extension stops before the migrated timeline was written completely, the next activation SHALL migrate it again from the earlier file.

#### Scenario: First activation after updating
- **WHEN** the extension activates in a workspace whose timeline was saved by the previous version
- **THEN** the same changes are restored with the same queue, and after the next save only the current form is kept

#### Scenario: Interrupted migration
- **WHEN** the window closes before the migrated timeline was first saved
- **THEN** the next activation restores it from the earlier file again
