# Design

## Context

File watchers report a rename as a delete of the old path and a create of the new one, in either order and on separate debounce bursts. Each burst is read on its own (`Recorder.flush`) and handed to `record`, which puts the change into the `ReorderBuffer`. The buffer holds every change for the reorder window after its write time (250 ms, 2.5 s on Windows) and longer while an earlier debounce burst is still unread (`pending`), so the two halves of a rename, whose watcher events arrive together, are normally both held at the same moment. Deletes in a chosen worktree are held longer still (`holdDelete`) to tell a removed checkout from a deleted file.

## Goals / Non-Goals

**Goals:**
- One `rename` event when a file is renamed or moved, with the before text captured at record time like every other change.
- Replay moves the mirror document instead of wiping one file and typing another.
- Older session files keep loading.

**Non-Goals:**
- Copy detection (a create matching a file that still exists).
- Pairing halves that arrive further apart than the reorder hold. They stay a delete and a create, as today.
- Moving the user's real files or tabs. Only mirrors move.

## Decisions

### 1. Pair at record time, against held changes

`record` checks, before adding a create (before text empty) or a delete (after text empty), whether the reorder buffer holds the opposite half: a delete for a create, a create for a delete. A create is also checked against the deletes held in a chosen worktree (`heldDeletes`): a create in the same checkout shows the checkout is not being removed, so that held delete is ended without being recorded. The matched half is taken out of the buffer (`ReorderBuffer.take`) and one rename is added instead.

*Alternative considered:* a separate pairing stage with its own timer in front of the buffer. The buffer already holds changes for exactly the time a pair can form, and already waits for unread bursts, so a second timer would only add latency.

### 2. What pairs

`src/renames.ts` (VS Code-free) decides:
- An exact match (same text) always pairs.
- Otherwise, when both texts are non-empty, the similarity is the number of unchanged lines (from `countChanges`) over the larger line count; 0.5 or more pairs, git's default rename threshold. The line-count ratio is an upper bound on it, so candidates that cannot reach 0.5 are skipped without a diff, and at most 16 candidates are diffed per change, the nearest in write time first.
- Among candidates, the highest similarity wins, then one with the same file name, then the nearest in write time. A directory move of several identical files (empty `__init__.py`, say) pairs each with its namesake.
- Only a create from empty pairs with a delete to empty. An "after own save" change, a modify, or an atomic replace of an existing file (a modify of the target) never pairs.

A rename with an edit is recorded as one rename whose before is the old file's text and whose after is the new file's text, so replay moves the mirror and then types the edit.

### 3. The event

`kind: 'rename'`, `uri` and `relPath` name the new path, new optional fields `fromUri` and `fromRelPath` name the old one (present exactly when the kind is `rename`), `before` is the deleted text, `after` the created text, `eol` the new file's, and the line counts come from `countChanges(before, after)`. Its write time is the later of the two halves' keys and it is held under the new path's key, so it stays after any earlier change to the old path and before any later change to the new one.

### 4. Filter and scope boundaries

Pairing only sees changes the recorder records, so a move from a filtered-out path into a recorded one is a create, and a move out is a delete. Moves between workspace folders or checkouts pair like any other: each half already has its own display path.

### 5. Playback

`Player.play` gets one additive step before its usual flow: for a rename it shows the old mirror with the before text, waits the file switch delay, writes the new mirror with the before text, shows it in the same column, closes the old mirror's tabs, and deletes the old mirror file. Then the usual modify flow types before → after into the new mirror, which is nothing for a pure rename. `snap` (skip to latest) retires the old mirror of a rename that is the newest event for the old path.

### 6. Timeline states

- `latestStates`: a rename removes its old path's entry, so a later snap does not refill it.
- `mirrorStates` (refill after a restart): a played rename drops the old path and sets the new path to its after text; a queued rename sets the old path to its before text and the new path to empty, unless an earlier event already decided either.

### 7. Session version 2

`SESSION_VERSION` becomes 2. `parseSession` accepts `rename` only from version 2 on and then requires string `fromUri` and `fromRelPath`; version 1 files parse as before. Files are always written as version 2.

### 8. Git replay

`commitChanges` runs `diff-tree -M` instead of `--no-renames`, and `parseDiffTree` reads `R<score>` records, which carry two paths. A rename whose two sides both pass the filter is a `rename`; one side filtered makes it a create or a delete. A pure rename is kept even though its before and after text are equal.

### 9. Labels

The tree shows the new name with `renamed from <old>` (plus line counts when edited) and the `diff-renamed` icon once played. The Playback panel and status row describe a rename as `#12 old → new`. Show Diff opens the old path's before text against the new path's after text.

## Risks / Trade-offs

- [A delete and an unrelated create of similar files within the window become a rename] → Same as git's heuristic; the before/after text is still exact, so replay ends in the right state either way.
- [Windows atomic writes] → They replace an existing file (a modify), which never pairs; a temp file the filters record pairs with the new target only when the target did not exist, which is what happened.
- [Directory moves larger than the window] → Files whose halves were released apart replay as delete and create, as before.
