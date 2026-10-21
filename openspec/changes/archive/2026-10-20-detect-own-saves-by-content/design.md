# Design

## Context

`Recorder` keeps `ownSaves: Map<uri, timestamp>`, set on `onWillSaveTextDocument` and `onDidSaveTextDocument`. `flush` skips the whole debounced change when that timestamp is less than 2 s old. Snapshots hold LF-normalized text plus the file's line ending. See proposal.md for why the window fails.

## Goals / Non-Goals

**Goals:**
- Skip a change only when its disk text is what the editor saved.
- Keep the skip-or-record decision in a pure, unit-tested function.

**Non-Goals:**
- Telling an agent's buffer edit followed by a save apart from the user's typing. That still needs `ignoreOwnSaves: false`.
- Splitting a debounced burst into separate user and agent events. The user's part is never replayed, so one event is enough.

## Decisions

### 1. Store saved text, not a time

`ownSaves` becomes `Map<uri, OwnSave>` with `OwnSave = { text: string; settled: Promise<void>; resolve(): void }`. `text` is LF-normalized.
- On will-save, store `doc.getText()` with a fresh unresolved `settled`.
- On did-save, set `text` to `doc.getText()`, which includes any save-participant edits, and resolve `settled`. With no prior will-save entry, create one already resolved.

A newer save replaces the entry, so only the latest save counts.

*Alternative considered:* a content hash instead of the text. That saves memory, but the text is needed as the before side when the disk differs, so a hash isn't enough.

### 2. Wait for did-save, at most one second

In `flush`, when an entry exists and `settled` is unresolved, await `Promise.race([settled, sleep(1000)])` before comparing. This only delays changes that coincide with a save in progress.

### 3. Pure decision in `src/ownSave.ts`

`decideOwnSave(savedText: string | undefined, diskText: string): { kind: 'external' } | { kind: 'own' } | { kind: 'after-own'; before: string }`
- `undefined` means there was no save: `external`, recorded against the snapshot as today.
- `savedText === diskText` means `own`: update the snapshot and record nothing.
- Otherwise `after-own`: record `before = savedText`, `after = diskText`.

In `flush`, the entry is deleted once it has been used, whatever the result: each save is matched once, against the next change read for that file. With `ignoreOwnSaves` off the map is ignored and nothing changes.

### 4. Change kind for `after-own`

`modify` when there was a previous snapshot or the file existed before. `create` when the burst created the file, which happens when the user saves a new file through the editor and the agent then overwrites it. Line endings come from the disk read, as today.

## Risks / Trade-offs

- [A save whose watcher event never arrives leaves a stale entry] → The next outside change to that file is recorded as saved text → disk text. That is a better before text than the stale snapshot, and the entry is then consumed.
- [The editor's in-memory text can differ from bytes on disk, for example BOM or encoding] → Comparison is on decoded, LF-normalized text, as with snapshots. If an encoding mismatch makes them differ, the change is recorded, which errs toward replaying.
- [Memory for saved text] → One entry per recently saved file, deleted on first use or on stop.

## Migration Plan

No data or settings migration. Behavior with `ignoreOwnSaves: false` is unchanged.
