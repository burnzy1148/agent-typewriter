# Proposal

## Why

The timeline lives only in memory, so reloading the window, restarting VS Code, or an extension host crash throws away every recorded change. A user who records an agent run and reloads before watching it loses the run (bead at-dqb.1). Saving sessions to a file (at-dqb.2) and rename detection (at-kbn.2) need a stable on-disk form of the timeline, so the format is defined here once, with a version.

## What Changes

- The timeline is saved to VS Code's per-workspace extension storage while the extension runs, and restored when the extension activates in that workspace again.
- The saved form is a versioned session format: a format tag, a version number, the playback cursor, and every event with its recorded before and after text. Later versions can add fields or change kinds; a file from a newer version is refused with a message rather than misread.
- On restore, each event keeps its recorded before and after text and its played or pending state. The current `historyLimit` applies, newest events kept.
- If the restored timeline has pending changes, playback starts paused, so a reload never starts typing on its own. The user resumes it with the existing pause/resume control.
- Saves are throttled while the timeline changes, and a final save happens when the extension deactivates. The saved data is capped in size, newest events kept, so a buffer of large files cannot make saving slow.
- New setting `agentTypewriter.persistHistory` (default `true`). Turning it off stops saving and deletes the saved timeline for the workspace.
- A saved timeline that cannot be read is logged and ignored. Recording starts normally with an empty buffer.

## Capabilities

### New Capabilities
- `session-persistence`: keeping the recorded timeline beyond one extension host lifetime, starting with restore across reloads. Export and import of session files (at-dqb.2) will add to it.

### Modified Capabilities
None.

## Impact

- `src/timeline.ts`: serialize the buffer and cursor to the versioned session format, parse and validate it, and replace the buffer with restored events.
- New `src/persistence.ts`: reads and writes the saved timeline in the workspace storage folder, throttled, without depending on the `vscode` module so it can be unit-tested.
- `src/extension.ts`: restores at activation before playback starts, pauses when restored changes are pending, saves on deactivate, reacts to `persistHistory`.
- `src/config.ts`, `package.json`, README: the new setting and a note on where history is kept.
- `it/runTest.ts`, new `it/restore.ts`: a second VS Code launch on the same workspace and user-data folder checks the restored timeline.
- Disk use in VS Code's extension storage folder, never in the workspace. No new dependencies (`zlib` is part of Node).
