# Proposal

## Why

After `smooth-scroll-to-edits`, replay scrolls to an edit that is out of view, but the caret still appears at each edit as if clicked. For an edit a few lines away a person reaches for the arrow keys: down a line at a time, then along the line by words. A caret that teleports between nearby edits reads as a machine.

## What Changes

- When the next edit in the same file is close by and in view, and so is the caret, the caret walks there with arrow-key steps: up or down a line at a time keeping its column, then along the line by word jumps and single characters, or Home/End for the ends of the line.
- The walk is used only up to 24 key presses. A farther edit, an edit that needed a scroll, and the first edit after a file switch are still clicked (the caret is placed at once).
- Key presses run at `agentTypewriter.arrowKeysPerSecond` (default 15), humanized and multiplied by the playback speed. Pause holds the walk, seek, skip, and skip to latest stop it, and finish current puts the caret at the edit at once.
- `agentTypewriter.arrowNavigation` (default `true`) turns the walk off.
- The caret only moves. The walk never edits text.

## Explore notes

This is the second half of what `at-mfk.2` asks for ("scroll and arrow toward the edit"). `at-2i9.5` already delivered the scroll half, in `smooth-scroll-to-edits`. This change adds the caret walk in the same `Player` navigation step and extends that change's `edit-navigation` capability.

## Capabilities

### New Capabilities
None.

### Modified Capabilities
- `edit-navigation`: nearby edits in view are reached with arrow keys. The "edit already in view" scenario now walks the caret instead of placing it.

## Impact

- New `src/caretPath.ts` (vscode-free): the key-by-key caret path, or none when it is too long. Unit tests in `test/caretPath.test.ts`.
- `src/player.ts`: a new `navigate` step in `typeHunk` runs the scroll, then the walk or the click.
- `src/config.ts`, `src/repoSettings.ts`, `package.json`, `schemas/agent-typewriter.schema.json`: two new settings.
- README settings table and CHANGELOG.
- `it/runTest.ts` turns the walk off for the general integration workspaces, so their timing stays as before. A dedicated `it/suite.ts` section turns it on and tests it.
