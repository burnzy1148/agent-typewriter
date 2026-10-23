## MODIFIED Requirements

### Requirement: Saved sessions are versioned
The saved timeline SHALL use a session format that carries a format identifier and a version number. A saved timeline with a newer version than the extension supports, an unknown change kind (including `rename` in a version 1 file), or missing or malformed fields (including a rename without its old path) SHALL NOT be restored. In that case the output channel SHALL say why, and recording and playback SHALL start normally with an empty buffer.

#### Scenario: Saved by a newer version
- **WHEN** the saved timeline's version is higher than the one this extension writes
- **THEN** nothing is restored and the output channel says it was saved by a newer version

#### Scenario: Damaged file
- **WHEN** the saved timeline cannot be decompressed or parsed
- **THEN** nothing is restored, the reason is logged, and the extension activates normally

## ADDED Requirements

### Requirement: Session format version 2 carries renames
Version 2 of the session format SHALL add the `rename` change kind, whose changes carry the old path as `fromUri` and `fromRelPath`. The extension SHALL write version 2 and SHALL read versions 1 and 2.

#### Scenario: Version 1 file
- **WHEN** a session saved before renames were recorded (version 1) is loaded
- **THEN** its changes load unchanged

#### Scenario: Rename round trip
- **WHEN** a buffer holding a rename is saved and loaded again
- **THEN** the loaded rename has the same old and new paths and text
