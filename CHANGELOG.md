# Changelog

## Unreleased

- Typing speed is set in characters per minute: `charsPerMinute` replaces `charsPerSecond`, and the default is 350 per minute (was 35 per second, 2100 per minute). **Set Playback Speed... > Base speed...** reads and writes it.
- `charsPerSecond` is deprecated but still honored, times 60, wherever `charsPerMinute` is not set. The output channel says when it is in effect.
- **BREAKING**: `languageSpeeds` values are characters per minute. Multiply existing values by 60 to keep the same speed.
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
