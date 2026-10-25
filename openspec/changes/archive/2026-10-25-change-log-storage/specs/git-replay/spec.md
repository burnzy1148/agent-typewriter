# Spec Delta

## MODIFIED Requirements

### Requirement: Replay replaces the buffer and starts playing
Replaying SHALL replace the buffer, after asking when the buffer is not empty. When watching, replaying SHALL stop watching so that live edits do not mix into the replayed history, and the confirmation SHALL say so. After replaying, every change SHALL be pending and playback SHALL start at the first one. When the range holds more changes than `agentTypewriter.historyLimit` or more change text than `agentTypewriter.historySizeMB`, the user SHALL get the same choice as when loading a session file: raise the limits or keep only the newest changes that fit.

#### Scenario: Replay starts playing
- **WHEN** the user picks a range and the replay is built
- **THEN** playback starts at the first replayed change without a separate resume

#### Scenario: Replay while watching
- **WHEN** the extension is watching with recorded changes in the buffer and the user replays a range and confirms
- **THEN** watching stops, the buffer holds only the replayed changes, and playback starts at the first one
- **AND** the changes are typed in commit order, each mirror ending with the file's text in the range's last commit that changed it

#### Scenario: Declined
- **WHEN** the buffer is not empty and the user declines the confirmation
- **THEN** the buffer, playback and watching are unchanged

### Requirement: Scripted replay
The command SHALL accept a range (and optionally a workspace folder) as an argument, which skips the pickers and the confirmation and keeps the newest changes within `agentTypewriter.historyLimit` and `agentTypewriter.historySizeMB`. A scripted replay SHALL start paused at the first change unless the argument asks it to play.

#### Scenario: Range larger than the size bound
- **WHEN** a script replays a range whose changes hold more text than `historySizeMB`
- **THEN** the buffer holds the newest replayed changes that fit, and a warning says how many of the range's changes were loaded

#### Scenario: Scripted replay
- **WHEN** a script runs the command with the range `main..feature` and no request to play
- **THEN** the buffer holds the replayed changes and playback is paused at the first one
