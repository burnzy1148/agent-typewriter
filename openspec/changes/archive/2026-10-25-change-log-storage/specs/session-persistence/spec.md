# Spec Delta

## MODIFIED Requirements

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

## ADDED Requirements

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

## REMOVED Requirements

### Requirement: Saved history is bounded in size
**Reason**: The buffer itself is now bounded by `agentTypewriter.historySizeMB`, and the saved timeline always holds exactly the buffer, so a separate cap on saved text would only make a reload lose changes the buffer still had.
**Migration**: Set `agentTypewriter.historySizeMB` to bound the buffer and its saved copy. Its default of 64 matches the old cap.
