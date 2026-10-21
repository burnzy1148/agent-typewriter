# Design

## Context

Today the pipeline is: watcher event → per-file debounce timer (`debounceMs`) → `flush` (stat, read, diff against snapshot) → `timeline.push`. The timeline is append-only and has a playback cursor, so an event cannot be inserted before one that is already there. Order therefore has to be settled before `push`. The CI timings that motivate this are in proposal.md and bead at-net.6.

## Goals / Non-Goals

**Goals:**
- Order changes by write time on every OS, with a bounded and configurable delay.
- Keep the reorder logic vscode-free so it can be unit-tested with an injected clock.

**Non-Goals:**
- Reordering events already in the timeline. Ordering is settled before `push`.
- Ordering writes that land within the filesystem's mtime resolution. Ties fall back to the order changes were read.
- Fixing late watcher delivery itself, or making the debounce window per-OS.

## Decisions

### 1. Order key: mtime, clamped to the watcher arrival window

For a create or modify, the key is the `mtime` from the `stat` that `flush` already does. For a delete, it is the arrival time of the first watcher event in that debounce burst. The key is then clamped to `[firstArrival - window, lastArrival]`:
- A write cannot happen after the watcher reported it, so an mtime later than `lastArrival` is clock skew or a future timestamp, and is capped.
- Tools that preserve old mtimes (`cp -p`, `rsync -t`, unzip) would otherwise sort a fresh change ahead of everything held. Any lag longer than the window is outside what we can reorder anyway, so the key is floored at `firstArrival - window`.

*Alternative considered:* ordering by first watcher arrival. That is no better than today when Windows delivers events out of order, and the arrival order was the thing that broke.

### 2. Reorder buffer in a new `src/reorder.ts`

`ReorderBuffer<T>` takes `now()`, a `setTimeout`-like scheduler, the window, and a `release(items)` callback. `add(item, key, fileKey)` holds an item. The buffer keeps one timer for the earliest due item. When it fires, every item whose key is at or before `now - window` is released, sorted by `(key, insertion seq)`.

The recorder's `record()` calls `buffer.add` instead of `timeline.push`, and `release` pushes to the timeline. With a window of `0`, `add` releases synchronously, which matches today's behavior.

### 3. Wait for flushes that are still pending

A file written earlier may still be in its debounce timer or mid-read when a later file's change is due. The recorder therefore registers each debounce burst with the buffer as pending (`pending(firstArrival)` returns a handle, resolved when that flush finishes, records or not). A due item is not released while a pending burst has `firstArrival <= item.key + window`, because that burst could carry an earlier write.

To stop a file that is rewritten nonstop from blocking everything, an item is always released by `item.key + 2 × window`.

### 4. Same-file order is forced

The buffer remembers the last key used per file and uses `max(key, lastKey)`, so a file's changes can never swap. The insertion sequence breaks ties. Swapping would break the rule that each event's before text follows the previous event's after text for that file.

### 5. `reorderWindowMs` setting

In `package.json` the type is `["string", "number"]` with default `"auto"`. `config.ts` resolves it to a number: `"auto"` or anything invalid gives `process.platform === 'win32' ? 2500 : 250`, and a finite number of zero or more is used as is. The resolver is a pure function, unit-tested with the platform passed in. A settings change applies to items added after it.

### 6. Releasing on stop and catch-up

`Recorder.stop()` calls `buffer.drain()`, which releases every held item in order, before it clears its state. Debounce timers that have not fired are still dropped, as today. The `catchUp` command calls `recorder.drainHeld()` before `timeline.seekToEnd()`, so the skip includes held changes.

### 7. Recorded time

`ChangeEvent.time` becomes the order key. The timeline view already shows `time`, so it now shows the write time.

## Risks / Trade-offs

- [Live replay starts up to one window later: about 250 ms on macOS/Linux, about 2.5 s on Windows] → The delay is configurable, and `0` restores today's behavior.
- [Windows watcher lag can exceed 2.5 s on slow or loaded machines] → Users can raise the window. The floor on the key keeps late changes from sorting far into the past.
- [The mtime of a debounce burst belongs to its last write] → A burst is one change, so its key is its last write. That matches what is replayed.
- [Network or virtual filesystems may report coarse or skewed mtimes] → The clamp limits the damage to reordering within one window.

## Migration Plan

No data migration. The new setting has a default, and setting it to `0` is the rollback if the delay is unwanted.
