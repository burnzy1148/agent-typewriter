# Spec Delta

## MODIFIED Requirements

### Requirement: Recorded changes last for the session
Recorded changes, played or queued, SHALL survive a reload of the plugin within a session, as when an option changes, each with its texts, whether it has played, whether it created its file, and when it was recorded. The change being typed then starts over. Changes SHALL NOT carry over to a new session. Besides the change being typed, at most 200 changes, with at most 20,000,000 characters of before and after text, SHALL be kept; past either limit, the oldest SHALL be dropped, played ones first.

#### Scenario: New session
- **WHEN** a session ends with changes queued and the user starts a new session
- **THEN** the new session's pane starts with no recorded changes

#### Scenario: Reload after changes played
- **WHEN** two changes have played, a third is being typed and a fourth is queued, and the plugin reloads
- **THEN** the two played changes are kept as played and do not play again, the third starts over, and the fourth plays after it

#### Scenario: Reload with nothing left to play
- **WHEN** every recorded change has played and the plugin reloads
- **THEN** the pane names the last change's file and shows its after text, and no change plays again

#### Scenario: Created file
- **WHEN** Claude creates `notes.md` with the `Write` tool and the plugin later reloads
- **THEN** the change to `notes.md` is still kept as creating the file, with the time it was first recorded

#### Scenario: Played changes past the limit
- **WHEN** 150 changes have played and 100 more are recorded before any of them plays
- **THEN** the 50 oldest played changes are dropped and all 100 new ones wait to play

#### Scenario: Change typed past the limit
- **WHEN** a change is being typed and 200 more are recorded behind it
- **THEN** the change being typed is still kept, so it finishes, or starts over after a reload, and all 200 changes recorded behind it are kept too

#### Scenario: Many edits to a large file
- **WHEN** Claude makes 100 edits to a 500 KB file faster than they can be typed
- **THEN** every edit is recorded until the kept text passes 20,000,000 characters, after which the oldest edits are dropped, played ones first, and playback keeps going

## ADDED Requirements

### Requirement: Changes saved by an earlier version still load
A change saved by an earlier version of the plugin without whether it had played, its kind or its time SHALL still survive a reload into a version that keeps them. Such a change SHALL wait to play and count as modifying its file, and its time SHALL be 0, which means the time it was recorded is unknown.

#### Scenario: Reload across an update
- **WHEN** changes were queued by a version of the plugin that saved neither their kind nor their time, and the plugin reloads into this version within the same session
- **THEN** those changes play in their recorded order, each counted as modifying its file, with time 0
