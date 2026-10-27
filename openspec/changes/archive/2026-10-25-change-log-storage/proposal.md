# Proposal

## Why

`agentTypewriter.historyLimit` bounds the buffer by change count, and every change holds its file's whole before and after text in the extension host. 500 changes to 512 KB files can hold 0.5–1 GB there. Saving makes it worse: `src/persistence.ts` rewrites the whole timeline as one `JSON.stringify` plus gzip at most every 2 s. 133 MB of JSON takes about 100 ms to stringify and 1.9 s to gzip, and 2500 changes of 130k characters each overflow V8's maximum string length, so the save fails outright (bead at-9oi).

## What Changes

- The buffer is bounded by the total size of its change text, set by a new `agentTypewriter.historySizeMB` (default 64, the size the saved history was already capped at). `historyLimit` stays as a count bound; the oldest changes are dropped until both hold. The newest change is always kept.
- With `persistHistory` on, the buffer is kept as an append-only log per lane in VS Code's workspace storage. A save appends only the changes recorded since the last one, plus a small state record (playback position, lanes, highlight clears). Nothing rewrites the whole timeline any more.
- Once a change is in the log, its text is no longer held in memory; it is read back when it is played, shown in a diff, or needed to work out highlights and mirror contents, through a small cache. The text read is the one captured when the change was recorded.
- Old changes leave the log as whole segment files once every change in them has fallen out of the buffer.
- A torn write (a crash or power loss in the middle of a save) loses at most the changes that were being written; every change written completely before it is restored.
- A timeline saved by an earlier version (`timeline.json.gz`) is restored once, written to the log, and then removed.
- **BREAKING** (storage only): the 64 MB cap on saved text is replaced by the buffer's own size bound, so the saved history always matches the buffer. An earlier version of the extension does not read the new log and starts with an empty buffer after a downgrade.
- Loading a session file or replaying git commits that exceed either limit offers to raise the limits, or loads the newest changes that fit both.

## Capabilities

### New Capabilities
- `change-buffer`: what the buffer of recorded changes keeps: its size and count bounds, which changes are dropped first, and how dropping queued changes is reported.

### Modified Capabilities
- `session-persistence`: restore applies both buffer bounds; the saved history's separate 64 MB cap is removed; saving appends instead of rewriting; recovery from torn writes; migration from the earlier saved timeline; change text read when needed; the large-session dialog covers the size bound.
- `git-replay`: a replayed range larger than either buffer bound gets the same raise-or-keep-newest choice, and a scripted replay keeps the newest changes within both bounds.

## Impact

- `src/timeline.ts`: size bound and `setSizeLimit`; changes carry their text through a text holder instead of plain strings, and `restore` keeps those holders; `mirrorStates` reads at most one text per file.
- New `src/changeText.ts`: text holders and the shared read cache.
- `src/persistence.ts`: `TimelineStore` rewritten around the per-lane segment logs and the state file, with migration and recovery. Session file reading and writing (`sessionToBytes`, `sessionFromBytes`) are unchanged.
- `src/highlights.ts`: `baselines` reads at most one text per file.
- `src/extension.ts`, `src/config.ts`, `src/repoSettings.ts`, `package.json`: the `historySizeMB` setting and the large-session and git-replay limit dialog.
- Docs: `site/` how-it-works, limits and session-files pages, README if it mentions the cap.
- Tests: `test/persistence.test.ts` rewritten for the log, new tests for the size bound and text holders; `it/restore.ts` keeps checking a real reload.
