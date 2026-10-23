# Proposal

## Why

A renamed or moved file reaches the recorder as a delete of the old path and a create of the new one. Replay then selects and wipes the whole old file and types the whole new one from scratch, which is slow, misleading (nothing was rewritten), and loses the link between the two names. Agents rename and move files often, so the timeline should show one rename and replay it as one (bead at-kbn.2).

## What Changes

- The recorder pairs a delete and a create whose content matches, recorded close enough together that the first is still held for reordering, and records them as one change of the new kind `rename`, carrying the old path. A rename with an edit (the new file's lines are at least half the same as the old file's, as git measures renames) is one rename whose before and after text differ; replay moves the mirror, then types the edit.
- Exact matches win over near matches; among equals, a file with the same name wins, then the nearest in time. Directory moves pair file by file.
- A rename between a path the filters record and one they leave out stays what the recorder sees: a delete (moved out) or a create (moved in).
- Playback of a rename shows the old mirror, then moves it to the new name (the old tab closes, the new one opens in its place) and types any edit. Skip to latest and the mirror refill after a restart leave no mirror at the old path.
- The changes tree, the Playback panel and the mirror status row label a rename as `old → new`. Show Diff compares the old path's text with the new path's.
- The session format goes to version 2, which adds the `rename` kind and its `fromUri` and `fromRelPath` fields. Version 1 files still load.
- Git replay maps git's renames onto the new kind, with the same 50% similarity git uses by default.

## Capabilities

### New Capabilities
None.

### Modified Capabilities
- `change-recording`: renames are recorded as one change.
- `mirror-documents`: a rename moves the mirror document; restored mirrors follow renames.
- `playback-controls`: rename labels in the panel and status row.
- `session-persistence`: session format version 2 with the `rename` kind.
- `git-replay`: git renames replay as renames.

## Impact

- `src/renames.ts` (new, VS Code-free): similarity and partner choice.
- `src/reorder.ts`: `take`, to remove a held item that another one pairs with.
- `src/recorder.ts`: pairing in `record`, including deletes held in a chosen worktree.
- `src/timeline.ts`: `rename` kind, `fromUri`/`fromRelPath`, `latestStates`/`mirrorStates`, session version 2.
- `src/player.ts`: a small, additive rename step before typing; `snap` retires renamed-away mirrors.
- `src/timelineView.ts`, `src/scrubberState.ts`, `src/scrubberHtml.ts`, `src/extension.ts` (Show Diff): labels.
- `src/gitReplay.ts`: `diff-tree -M`, rename records.
- Tests: unit tests for pairing, reorder `take`, sessions, git replay, and the recorder on real files; integration checks for a live rename and rename playback.
- Out of scope: copy detection, and pairing a delete and create that arrive further apart than the reorder hold.
