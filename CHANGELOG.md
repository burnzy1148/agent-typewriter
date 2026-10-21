# Changelog

## 0.1.0 (unreleased)

First public release.

- Watch the workspace for changes on disk and replay each one as human-like typing in `agent-typewriter:` mirror editors, flipping between files in the order they changed.
- Timeline panel in the Explorer with pending, typing, and played states, diffs, and **Replay From Here**.
- Catch-up speed when playback falls behind, a session speed multiplier, and per-language base speeds (`languageSpeeds`).
- Changes enter the timeline in write order, using file modification times and a short reorder window (`reorderWindowMs`), so late or out-of-order watcher events on Windows still replay correctly.
- Your own saves are recognized by content, so an outside write right after your save is still replayed (`ignoreOwnSaves`).
- CRLF files keep CRLF in the replay.
- Clean, git-tracked files use git as their baseline instead of memory (`gitBaselines`); other baselines fit a memory budget (`baselineBudgetMB`) instead of a fixed file cap.
- Filtering by extension allow-list, include globs, and exclude globs, with Explorer shortcuts.
