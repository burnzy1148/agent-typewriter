# Proposal

## Why

With `ignoreOwnSaves` on (the default), any write that lands within 2 s of a VS Code save is treated as the user's own and is not recorded. The Claude Code VS Code extension saves the user's unsaved editor changes right before an Edit tool call, and the agent's edit is written to disk milliseconds later. The debounce merges both writes into one change, so the agent's edit is dropped and never replayed (bead at-net.2).

## What Changes

- A save from a VS Code editor is recognized by content, not timing. The recorder remembers the text each editor save wrote.
- When the file on disk matches that text, the change is the user's own and is skipped, as today.
- When the file on disk differs from it, something else wrote after the save. The recorder records a change from the user's saved text to the disk text, so the agent's edit is replayed and the user's own edits are not.
- The 2-second own-save window is removed. A save is matched once, against the next change read for that file.
- If the recorder reads the file between will-save and did-save, it waits briefly for did-save, so edits made by save participants (format on save) count as the user's.

## Capabilities

### New Capabilities
None.

### Modified Capabilities
- `change-recording`: adds requirements for how saves from VS Code editors are recognized and what is recorded when another write follows one. No existing requirement changes.

## Impact

- `src/recorder.ts`: stores saved text per file instead of a timestamp, and uses it when reading a change.
- New vscode-free helper (for example `src/ownSave.ts`) that decides skip vs. record and the before text, with unit tests.
- `it/suite.ts`: a new section that saves an editor change and writes the file from outside right after, expecting only the outside edit to be recorded.
- `package.json` and README: the `ignoreOwnSaves` description still says to turn it off when an agent both edits and saves through VS Code buffers. That case is unchanged and out of scope.
