# Design

## Context

See proposal.md for why. Today:

- `Timeline` keeps `ChangeEvent`s in one array with contiguous seqs, trimmed to `limit` (from `historyLimit`) by count. Each event carries `before` and `after` as plain strings, so the extension host holds all of it.
- `TimelineStore` (`src/persistence.ts`) builds a `Session` with `toSession(timeline, 64 Mi chars)`, joins cached per-event JSON into one string and gzips it into `<storage>/timeline.json.gz` every 2 s while the timeline changes, plus a synchronous `flushSync` on deactivation. It caches each event's JSON, but the join, the gzip and the write still cover the whole buffer.
- Text is read in many places, all synchronously: the player (`e.before`, `e.after`), `Timeline.mirrorStates` (mirror refill and highlights), `baselines` in `src/highlights.ts` (every highlight pass), `latestStates`/`snapTargets` (skip to latest), `SnapshotProvider` (diffs), `TimelineView` (rename rows), `toSession` (session files), the recorder's rename pairing (only on `NewChangeEvent`s it still holds, before they reach the timeline).
- Tests and the integration suite read `e.before`/`e.after` on timeline events and compare `timeline.all()` with plain objects using `deepStrictEqual`.

Constraints from CLAUDE.md: the before text is captured at record time, never at play time; recording and playback stay decoupled through the `Timeline`; the extension writes only to its storage folder.

## Goals / Non-Goals

**Goals:**
- Memory in the extension host grows with the number of changes (metadata) and a fixed cache, not with their text, while `persistHistory` is on.
- A save costs what changed since the last one, never the whole buffer.
- A crash at any point loses at most the changes being written.
- Existing saved timelines and session files keep working.

**Non-Goals:**
- Keeping text out of memory with `persistHistory` off. That mode promises to write nothing, so the text stays in memory, bounded by the new size bound.
- Changing the session file format. Session files stay one JSON document; saving one reads every change's text once.
- Deduplicating a change's before text against the previous change's after text. It would halve disk use but makes a record depend on another that may already have fallen out of the buffer.
- fsync on every save. Torn writes are detected and recovered instead (Decision 6).

## Decisions

### 1. A size bound beside `historyLimit`, which is kept

New setting `agentTypewriter.historySizeMB` (default 64, minimum 1, repository settings file too). The bound is `historySizeMB × 1024 × 1024` characters of before plus after text across all lanes. Counting characters, not UTF-8 bytes, matches the old 64 MB cap (which also counted characters) and is known without encoding. `Timeline` keeps a running total and `trim()` drops the oldest change while either bound is exceeded, except that the newest change always stays: a change bigger than the bound (possible with a large `maxFileSizeKB`) would otherwise empty the buffer. `setSizeLimit` mirrors `setLimit`.

`historyLimit` is **kept** as a count bound, with its default of 500, and not deprecated:
- It bounds what the size bound does not: per-change metadata, the Changes view and the scrubber, which list every change.
- There is no faithful conversion from a count to a size, so migrating a user's value would change what they get.
- Values users and repository files already set keep their meaning.

The 64 MB cap on *saved* text (`MAX_SAVED_TEXT_CHARS`) goes away: the default size bound equals it, and the saved history now always holds exactly the buffer, so a reload never loses changes the buffer still had.

The large-session dialog (session files and git replay) checks both bounds. "Raise limits" raises whichever is exceeded to fit the incoming changes (`historySizeMB` rounded up); "Load newest N" names how many fit both. The dropped-changes message in the Changes view names both settings.

*Alternatives:* deprecating `historyLimit` in favor of size only (rejected: see above); a size bound only on the saved copy (today's behavior; it leaves memory unbounded, which is the bug).

### 2. Change text behind a holder; `ChangeEvent` keeps `before`/`after` as getters

New `src/changeText.ts`. Each change in the timeline owns a `TextHolder` that knows its character count and returns `{ before, after }`:
- *In memory*: created by `Timeline.push` from the strings the recorder captured, or by `restore` for plain events (session files, git replay).
- *Offloaded*: once the store has appended the change to the log, it hands the holder a reader for that record and the holder drops its strings. Reads go through one module-level LRU cache bounded by characters (32 Mi), so text that is read repeatedly (the change being typed, every mirror's current text and baseline for highlights) keeps the same string objects and is not re-read.

Timeline events are plain objects whose `before` and `after` are enumerable getters reading through the holder (a `WeakMap` from event to holder). Everything that reads `e.before` keeps working, `deepStrictEqual` against plain objects still compares the text, and `{ ...e }` or `JSON.stringify(e)` produce plain data. `restore` no longer spreads events (that would read every text); it rebinds each event to a new seq with the same holder. `toSession` sums holder character counts instead of string lengths.

Readers are synchronous (`fs.readSync` of one record): one record is at most a few MB of one file, a sub-millisecond page-cache read, and staying synchronous keeps `mirrorStates`, `baselines`, the diff provider and the player unchanged.

Code that walked every event's text is changed to read at most one text per file: `Timeline.mirrorStates` and `baselines` keep which event and side decides each file's text and read only those at the end. `latestStates` and `snapTargets` already return events, so they read nothing.

*Alternatives:* an async `textOf(seq)` API (rejected: async would ripple through highlights, mirror refill, the snapshot provider and hundreds of test lines for no gain over a sub-millisecond read); a `ChangeEvent` without text plus a separate lookup (rejected for the same churn); `WeakRef`-based caching (rejected: collection timing is unpredictable, so strings would be re-read and lose identity, which makes the highlight cache compare whole texts).

### 3. Log layout: per-lane segment files plus one state file

Everything lives in `<storage>/history/`:

- `state.json`: `{ format: "agent-typewriter-history", version: 1, savedAt, first, next, cursors, followed, lanes, highlightsFrom }`. Small (no text, no per-change metadata); rewritten on every save through a temp file and a rename, so it is always whole.
- `<lane>.<n>.log`: segments of one lane's changes. `<lane>` is the first 16 hex digits of the SHA-1 of the lane id (lane ids are opaque and may hold path characters), `<n>` a zero-padded counter. A segment starts with a header line `{"format":"agent-typewriter-log","version":1,"lane":"<id>"}\n`, then records:

  ```
  {"o":17,"uri":"…","relPath":"src/a.ts","time":…,"kind":"modify","eol":"\n","linesAdded":2,"linesRemoved":1,"c":1234,"b":610,"a":640,"crc":3735928559}\n
  <b bytes of before text, UTF-8><a bytes of after text, UTF-8>
  ```

  `o` is the change's order (Decision 5), `c` its character count (for the size bound without reading text), `b`/`a` the byte lengths, `crc` a CRC-32 of the text bytes. Renames add `fromUri`/`fromRelPath`. A new segment is started when the current one has reached 4 MiB; a record is never split, so a big change gets a segment of its own.

Text is raw UTF-8 after a JSON header rather than inside JSON: no escaping or parsing of large strings, and a read is one slice at a known offset. One file per lane, as asked for in at-9oi, means a lane that is removed (cleared, or stopped with nothing left) is deleted as a set of files without touching other lanes.

*Alternatives:* JSON Lines with the text inline (rejected: load would parse every text, and a lazy read would need the line parsed); one log for all lanes (workable, but lanes come and go independently and per-lane files make that a file delete).

### 4. Compaction drops whole segments

Changes leave the buffer only from its oldest end (both bounds trim the oldest; Clear Buffer, session load and git replay replace everything), so within a lane the dead records are always a prefix of its log. A save therefore deletes every segment whose records are all dead, and records `first`, the order of the buffer's oldest change, in `state.json`; dead records still sitting in a live segment are skipped on load. Nothing is ever copied, so compaction costs a few unlinks. The waste is under one segment (4 MiB) per lane.

If a save finds the prefix property broken (a change not yet written that is older than one already written, or a dead record after a live one in a lane, which current callers never produce), it reads the live changes' text back into memory, deletes the lane's segments and writes the lane again. This keeps the store correct whatever `restore` is given.

*Alternatives:* one file per lane rewritten without its dead prefix (rejected: copies up to the whole buffer on the extension host, the cost this change removes); `fallocate` collapse-range (Linux only).

### 5. Order numbers instead of seqs

Seqs are renumbered by every `restore`, so they cannot identify records across reloads. The store gives each record an order number from its own counter (`next` in `state.json`, also at least the highest order on disk plus one), assigned in seq order. Within the buffer order and seq always increase together, so positions translate both ways: a cursor or clear at seq `s` is saved as the order of the first change at or after `s` (or `next`), and `load()` returns a `Session` whose events use their order as seq, which `Timeline.restore` maps to fresh seqs by position as it already does for session files.

### 6. Writes are synchronous, incremental, and crash safe

A save (throttled every 2 s, the final save on deactivation, `flush()` in tests) does, synchronously:
1. Append every change not yet in the log, oldest first, one `writeSync` per segment; then offload their holders.
2. Delete segments that hold only dead records, and the segments of lanes with nothing left.
3. Write `state.json.tmp` and rename it over `state.json`.

A save writes only new text plus a state record of a few KB, so doing it synchronously costs about what recording the changes did, and it removes the async write, the overtaken-write bookkeeping and the gzip of the old store. `flushSync` is the same code.

Recovery on load, per segment: a header line that does not parse, a record whose text runs past the end of the file, or a record whose CRC does not match ends the segment there. The file is truncated after the last good record, so later appends follow good data, and the output channel says how many changes were left out. Any later segment of that lane is dropped too, since its changes came after the lost ones. A crash between steps 1 and 3 leaves records newer than `state.json`; they load as pending changes after the saved cursor. A crash during step 3 leaves the previous `state.json` whole. Leftover `*.tmp` files are deleted on load. The whole log is read once at load to check every CRC, so a damaged change is found then, not mid-playback; this is no more reading than the old store's gunzip of the same data. If a read during the session still fails (the files were removed by hand), the change's text reads as empty and the output channel says so once.

A `state.json` that does not parse is treated as missing (changes restore pending, logged). A `state.json` or segment with a newer format version means a newer extension wrote it: nothing is restored, the `history` folder is renamed to `history.unreadable` so it is not overwritten, and saving waits until that rename succeeds, as the old store did for `timeline.unreadable.json.gz`.

### 7. The before text is still captured at record time

`Timeline.push` receives the strings the recorder captured and keeps them in the holder until the store appends them, from those same strings, to the log. The log is the only place a holder reads back from, and records are never rewritten from anything but the in-memory or logged text of the same change. Nothing in the read path looks at the workspace, so a file rewritten on disk after recording, or removed, never changes what plays. Turning `persistHistory` off reads every offloaded change back into memory before deleting the log.

### 8. Migration from `timeline.json.gz`

`load()` looks for `history/`. If it has no `state.json` and the old `timeline.json.gz` exists, the migration has not completed: any segments are deleted and the old file is read as before (`sessionFromBytes`, setting it aside when unreadable). The extension restores that session as it does today; the store's first save writes every change to the log and `state.json`, and only then deletes `timeline.json.gz`. A crash before that point leaves the old file in place, so the next activation migrates again. `history/` without `state.json` and without an old file is a log whose first state was never written; its changes load as pending.

Downgrading after migration starts with an empty buffer, because the old version reads only `timeline.json.gz`. The old version never touches `history/`, so upgrading again restores it.

## Risks / Trade-offs

- [Highlights and mirror refill need the current text and the baseline of every file in the buffer; if that exceeds the 32 Mi-character cache, a highlight pass re-reads from disk] → Reads are bounded to two per file per pass, passes are throttled and time-budgeted already, and the page cache keeps the files hot. The cache size is one constant if it needs tuning.
- [Activation reads the whole log once to verify it] → No more than the old store's gunzip and parse of the same data, and it keeps damaged text out of playback. Only CRC is computed; nothing is parsed or kept.
- [Characters versus bytes: the bound counts characters, so non-ASCII text uses more disk than the setting suggests] → At most 3 bytes per character for BMP text; documented in the setting.
- [Lone UTF-16 surrogates do not survive UTF-8] → They cannot come from decoded files, which are always well formed; the length is preserved, so a mismatch would only show as a replacement character.
- [Windows may refuse to delete a segment held open by another process, such as a virus scanner] → A failed delete is retried on the next save; the dead records are skipped on load either way.
- [Downgrade loses the saved buffer] → Noted in the changelog; an upgrade again restores it.

## Migration Plan

Automatic, per workspace, on the first activation after updating (Decision 8). No setting changes: `historySizeMB` defaults to the old saved-text cap. Rollback is installing the earlier version, which starts empty and leaves `history/` alone.
