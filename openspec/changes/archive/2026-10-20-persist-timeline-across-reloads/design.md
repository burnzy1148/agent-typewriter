# Design

## Context

`Timeline` holds `ChangeEvent`s in an array with contiguous seqs, a cursor seq (next to play), a `playingSeq`, and a generation counter that invalidates in-flight playback on seeks. `Player` starts its loop in its constructor and begins the first pending event as soon as `peek()` returns one. Mirror documents live in `MirrorFileSystem`, in memory only, so they are empty after a reload; `Player.play` already snaps a mirror to the event's before text when it does not match, so replaying a restored event works without the mirror having survived.

Save and load of session files (at-dqb.2) and a rename kind (at-kbn.2) will build on the format defined here.

## Goals / Non-Goals

**Goals:**
- One versioned session format, owned by `src/timeline.ts`, that persistence and later file export share.
- Restore is exact: events come back with the text captured at record time, in order, with their played/pending state.
- Saving never blocks typing noticeably and never touches the workspace.

**Non-Goals:**
- Recording changes made while VS Code was closed. The recorder takes fresh baselines when it starts, as today.
- Restoring mirror tabs, the paused flag, or the speed multiplier as they were. Only the timeline and cursor are kept.
- Sharing history between workspaces or machines (that is at-dqb.2).

## Decisions

### 1. Session format in `src/timeline.ts`

```jsonc
{
  "format": "agent-typewriter-session",
  "version": 1,
  "savedAt": 1792000000000,      // epoch ms
  "cursor": 12,                  // seq of the next change to play
  "events": [ { "seq": 10, "uri": "...", "relPath": "src/a.ts", "time": 0, "kind": "modify",
                "before": "...", "after": "...", "eol": "\n", "linesAdded": 1, "linesRemoved": 0 } ]
}
```

- `toSession(timeline, maxTextChars)` builds this object from the newest events whose `before.length + after.length` fit in `maxTextChars`, and reports how many were left out.
- `parseSession(raw: unknown)` validates every field (format tag, integer version, string texts, known kind, `eol` of `\n` or `\r\n`, increasing seqs) and throws `SessionFormatError` with a readable reason. Versions above `SESSION_VERSION` are refused as "saved by a newer version".
- Versioning: `parseSession` reads any version from 1 up to `SESSION_VERSION` and upgrades older shapes to the current one step by step. A later version that adds a kind (rename) bumps `SESSION_VERSION`, accepts the new kind and its extra fields, and keeps reading version 1 unchanged. Old extensions refuse the newer files instead of misplaying them.
- Every event field is stored verbatim; nothing is derived on load, so the before text is still the one captured at record time.

*Alternative considered:* storing only `after` and deriving `before` from the previous event of the same file. It halves the size but breaks when the first event of a file was trimmed, and it would derive before text at load time, against the record-time rule. Gzip recovers most of the duplication instead.

### 2. `Timeline.restore(events, cursor)`

Replaces the buffer like `clear()` does (bumps the generation, clears `playingSeq` and `droppedUnplayed`), then appends the events renumbered from the timeline's current `nextSeq`, so seqs stay unique for the life of the timeline and contiguous for `indexOfSeq`. The cursor maps by position: the new cursor sits before the first event whose old seq is `>= cursor`. The current `limit` is applied by keeping the newest events, and the cursor is clamped into the kept range. One `onDidChange` fires.

*Alternative considered:* keeping the saved seqs. Imported sessions in at-dqb.2 would then collide with seqs already handed out, and `SnapshotProvider` diff URIs would point at the wrong events.

### 3. `src/persistence.ts`: `TimelineStore`

Plain Node (`fs`, `zlib`), no `vscode` import, so unit tests can drive it with a temp folder. Constructed with the storage folder path, the timeline, and a log function.

- **File:** `<context.storageUri>/timeline.json.gz`. `storageUri` is VS Code's per-workspace extension folder, outside the workspace. With no folder open there is no `storageUri` and nothing is persisted.
- **Load:** synchronous `readFileSync` + `gunzipSync` + `parseSession` at activation. A missing file is an empty start. Any other failure is logged, the file is renamed to `timeline.unreadable.json.gz` so a downgrade does not silently overwrite a newer session, and activation continues with an empty timeline.
- **Save:** `onDidChange` marks the store dirty and arms a 2 s timer if none is armed. That is a throttle, not a debounce, so continuous playback still saves every 2 s. When it fires, the store serializes, gzips asynchronously, writes `timeline.json.gz.tmp` and renames it over the file. One write runs at a time; changes during a write arm the timer again.
- **Cheap cursor-only saves:** events are immutable and seqs unique, so the first and last seq identify the event list. The store caches the JSON of the events array under that key and rebuilds only the small envelope when only the cursor moved.
- **Final save:** `flushSync()` serializes, gzips and writes synchronously. `deactivate()` drains the recorder's held changes and calls it; `dispose()` calls it too, so it runs whichever comes first, and does nothing when not dirty.
- **Size cap:** `MAX_SAVED_TEXT_CHARS` is 64 Mi characters. When events are left out, one log line says how many, once per distinct count.

### 4. Activation order

`extension.ts` creates the timeline, player and recorder as today, then loads the saved session. If it has pending events, it pauses the player before calling `timeline.restore`, so the player's loop, waiting on the empty timeline, wakes up paused and types nothing. Restore happens before `autoStart` runs, so newly recorded changes go after the restored ones. A log line reports how many changes were restored and how many are queued.

### 5. Setting `agentTypewriter.persistHistory`

Boolean, default `true`. Read at activation and on configuration change. Off: stop the store and delete the file. On: start the store and save at once. `Clear Buffer` needs nothing special: it changes the timeline, which saves an empty session.

## Risks / Trade-offs

- [Saved history holds file contents on disk in VS Code's storage folder] → It is the user's own workspace storage, deleted with the workspace's storage. `persistHistory: false` turns it off and removes the file. The README says where history lives.
- [Serializing a large buffer every 2 s during playback] → The events JSON is cached across cursor-only changes and gzip runs on Node's thread pool. The 64 Mi character cap bounds the worst case.
- [Crash between saves loses up to 2 s] → Accepted. A clean reload or shutdown runs the final save.
- [Two windows on the same workspace share one storage folder] → The last writer wins. VS Code itself discourages that setup, and the file is always a complete session because of the rename.
- [A restore replaces nothing the user could lose] → Restore runs only at activation, on an empty timeline.

## Migration Plan

Nothing to migrate. The first activation with this version finds no saved file and starts empty, as before. Setting `persistHistory` to `false` restores the old behavior.
