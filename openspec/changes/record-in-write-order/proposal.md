# Proposal

## Why

The recorder adds a change to the timeline when that file's debounce timer fires, so the timeline follows the order in which watcher events arrive, not the order in which files were written. On Windows CI, watcher events arrived 1–2 s after the writes and close together, and one run replayed `a, existing, b, a` instead of `a, b, existing, a` (bead at-net.6, found while verifying at-net.4). Replaying in true write order is the product's core promise, so this needs to hold on every OS.

## What Changes

- Changes are ordered by when the file was written: the file's modification time for creates and modifies, and the time the first watcher event arrived for deletes.
- Each recorded change is held for a short reorder window before it is added to the timeline, so a change whose watcher event arrives late still lands in its correct place.
- New setting `agentTypewriter.reorderWindowMs`. The default `"auto"` uses about 2500 ms on Windows and about 250 ms on macOS and Linux. A number sets a fixed window, and `0` adds changes as soon as they are read, as today.
- Changes to the same file always keep their recorded order, whatever their timestamps.
- Held changes are not lost: stopping recording and "catch up" both release them to the timeline immediately, in order.
- A change's recorded time becomes its write time instead of the time it was processed.

## Capabilities

### New Capabilities
- `change-recording`: how file writes in the workspace become ordered change events in the timeline, including ordering, the reorder window, and its setting.

### Modified Capabilities
None. The existing `mirror-documents` and `typing-pace` requirements are unchanged.

## Impact

- `src/recorder.ts`: computes an order key per change and routes changes through the reorder buffer instead of pushing them to the timeline directly.
- New vscode-free module (for example `src/reorder.ts`) holding the reorder buffer, so it can be unit-tested with an injected clock.
- `src/config.ts` and `package.json`: the `reorderWindowMs` setting. README settings table.
- `src/extension.ts`: catch-up releases held changes before skipping to latest.
- `test/`: unit tests for the reorder buffer. `it/suite.ts`: a deterministic ordering check that uses `fs.utimesSync` to set modification times out of arrival order.
- Live replay starts up to one reorder window later than today.
