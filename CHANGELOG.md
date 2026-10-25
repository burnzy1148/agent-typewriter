# Changelog

## Unreleased

- Changes are typed in the order a person writes them: a new block gets its closing line right after its opening line, then its body is filled in between, and a function's signature comes before its body, even with its parameters on several lines (`naturalOrder`, default on). Moving back into the block and past its closing line never waits for the read pause or scrolls. Edits in different places are still typed top to bottom.
- Docs moved to [agent-typewriter.com](https://agent-typewriter.com), with search and a settings reference generated from the extension, and the Marketplace listing links there. The README keeps install and quick start.
- Replay waits for a read pause before the view leaves what it just typed: before scrolling or jumping to an off-screen edit, and before switching to another file, while the old file is still in view (`readPauseSeconds`, default 1.5). Time already passed counts, so a change that arrives after an idle gap switches at once. Seeks, skips and catch up skip it; finish current ends it.
- `fileSwitchDelayMs`, the pause on the new file before its first edit, now defaults to 1000 (was 600) and is capped at 15000.
- `scrollPauseMs` is deprecated but still honored, divided by 1000, wherever `readPauseSeconds` is not set. The output channel says when it is in effect.
- **BREAKING**: with `smoothScroll` off, an off-screen edit now waits for the read pause before the jump. Set `readPauseSeconds` to 0 for the old behavior.

## 0.3.0 (2026-10-24)

- The caret walks to a nearby edit with arrow keys, a line at a time and then by words, instead of appearing there (`arrowNavigation`, `arrowKeysPerSecond`). Far edits are still scrolled to and clicked.
- The next edit in the same file is scrolled to instead of jumped to: a short pause to read the last lines typed (`scrollPauseMs`), then an eased scroll (`scrollLinesPerSecond`) that follows the playback speed, pause, and skip. `smoothScroll: false` brings back the jump.
- Typing speed is set in characters per minute: `charsPerMinute` replaces `charsPerSecond`, and the default is 350 per minute (was 35 per second, 2100 per minute). **Set Playback Speed... > Base speed...** reads and writes it.
- `charsPerSecond` is deprecated but still honored, times 60, wherever `charsPerMinute` is not set. The output channel says when it is in effect.
- **BREAKING**: `languageSpeeds` values are characters per minute. Multiply existing values by 60 to keep the same speed.
- Renamed and moved files are recorded as one rename, not a delete and a create, when the content matches (or at least half the lines are unchanged). Replay moves the mirror to the new name and types any edit. Git replay maps git's renames the same way. Saved sessions are now version 2; version 1 files still load.
- Mirror tabs left open across a reload or restart reopen with their text at the playback position, instead of "file not found". Mirror tabs for files with no recorded history are closed.

## 0.2.0 (2026-10-21)

- Only the folder's own git checkout is recorded; other worktrees inside it are skipped. **Choose Checkout...** records another worktree instead, inside or outside the workspace.
- Marketplace icon and gallery banner.

## 0.1.0 (2026-10-21)

First public release.

- Watch the workspace for changes on disk and replay each one as human-like typing in `agent-typewriter:` mirror editors, flipping between files in the order they changed.
- Timeline panel in the Explorer with pending, typing, and played states, diffs, and **Replay From Here**.
- Catch-up speed when playback falls behind, a session speed multiplier, and per-language base speeds (`languageSpeeds`).
- Changes enter the timeline in write order, using file modification times and a short reorder window (`reorderWindowMs`), so late or out-of-order watcher events on Windows still replay correctly.
- Your own saves are recognized by content, so an outside write right after your save is still replayed (`ignoreOwnSaves`).
- CRLF files keep CRLF in the replay.
- Clean, git-tracked files use git as their baseline instead of memory (`gitBaselines`); other baselines fit a memory budget (`baselineBudgetMB`) instead of a fixed file cap.
- Filtering by extension allow-list, include globs, and exclude globs, with Explorer shortcuts.
- Recorded changes and the playback position are kept across reloads and restarts (`persistHistory`).
- **Save Session to File...** and **Load Session from File...** take a recorded run to another window or machine.
- **Explorer > Playback** panel with play, pause, skip, seek, and speed controls.
- Optionally skip paths git ignores (`respectGitignore`).
- A committed `.agent-typewriter.json` gives a repository its own settings, including named filter profiles (`profiles`).
