# Proposal

## Why

When replay makes several edits in one file in a row, the view jumps to each next edit with `revealRange`. A jump cut makes it hard to follow where the change went, and nobody moves through a file like that. A person reads the lines they just wrote, then scrolls down (or up) to the next spot.

## What Changes

- Before an edit in the same file whose line is outside the viewport, replay pauses briefly (`agentTypewriter.scrollPauseMs`, default 400), then scrolls the view to the edit in eased steps (`agentTypewriter.scrollLinesPerSecond`, default 60) instead of jumping.
- An edit already in view only moves the caret, as today.
- Long distances stay short: the view jumps to within two screen heights of the edit, then scrolls the rest, and a scroll takes at most one second at 1x.
- The pause and the scroll are divided by the playback speed (manual speed times catch-up). Pause holds a scroll, seek, skip, and skip to latest stop it, and finish current jumps to the edit.
- Switching to another file keeps its current behavior: the file-switch pause, then a jump.
- `agentTypewriter.smoothScroll` (default `true`) turns this off and brings back the jump.

## Explore notes

`at-mfk.2` (simulated navigation: scroll and arrow toward the edit) overlaps this one. The two split cleanly: this change moves the viewport, `at-mfk.2` moves the caret with arrow keys inside it. They stay separate changes. This one puts navigation in one `Player` method and a new `edit-navigation` capability that `at-mfk.2` extends.

## Capabilities

### New Capabilities
- `edit-navigation`: how replay brings each edit into view before typing it.

### Modified Capabilities
None.

## Impact

- New `src/scroll.ts` (vscode-free): target top line and the per-frame scroll path. Unit tests in `test/scroll.test.ts`.
- `src/player.ts`: `typeHunk` brings the edit into view through a new `scrollTo`, which runs the scroll frames and checks pause and interruption every frame.
- `src/config.ts`, `src/repoSettings.ts`, `package.json`, `schemas/agent-typewriter.schema.json`: three new settings.
- README settings table, CHANGELOG, and an integration test section in `it/suite.ts`.
- Text is never edited by scrolling, so the final mirror text still equals the after text.
