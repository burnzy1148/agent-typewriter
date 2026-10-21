# Proposal

## Why

A recorded agent run is only replayable in the window and workspace that recorded it. To demo a run later, on another machine, or to hand it to a reviewer, the user needs to take the timeline out as a file and load it back (bead at-dqb.2). The versioned session format from at-dqb.1 already describes a whole timeline, so a file is that format written where the user picks.

## What Changes

- New command **Save Session to File...** writes the whole buffer to a file the user picks in a save dialog, as session format JSON. The dialog starts in the user's home folder, not the workspace, so a session file is not recorded as a change by accident.
- New command **Load Session from File...** reads a session file the user picks (plain or gzip-compressed JSON), validates it, and replaces the buffer with its changes, after confirming when the buffer is not empty. Playback starts paused at the session's first change, so the user decides when to start.
- A session with more changes than `historyLimit` asks whether to raise the limit to fit the session or load only the newest changes.
- An invalid file, or one from a newer version, is refused with a message saying why. The buffer is left as it was.
- Both commands are in the panel's `...` menu and the Command Palette. Both also accept a file URI argument, which skips the dialogs, for scripting and tests.
- Loaded changes are only replayed into mirror documents. The extension still never writes the user's real files. The only file written is the one the user picks.

## Capabilities

### New Capabilities
None.

### Modified Capabilities
- `session-persistence` (added by at-dqb.1): adds requirements for saving the buffer to a file and loading a file into the buffer.

## Impact

- `src/persistence.ts`: `sessionToBytes` and `sessionFromBytes` (gzip detected by its magic bytes), shared with `TimelineStore`.
- `src/extension.ts`: the two commands, their dialogs and confirmation, the `historyLimit` choice, pausing the player.
- `package.json`: the commands and their menu entries. README: a section on session files.
- `test/persistence.test.ts`: file encoding round trips. `it/restore.ts`: save to a file outside the workspace, clear, load, and replay.
