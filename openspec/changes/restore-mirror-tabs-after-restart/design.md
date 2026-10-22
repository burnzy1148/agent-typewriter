# Design

## Context

`MirrorFileSystem` keeps mirror files in a `Map` in memory. `activate` registers it as the `agent-typewriter` provider right away, then restores the saved timeline inside `historyRestored`, which first waits for `repoFile.ready`. The `onFileSystem:agent-typewriter` activation event (added by review group PLAY) makes a restored mirror tab activate the extension. But nothing fills the map from the restored timeline, so `stat` and `readFile` throw `FileNotFound`. Today a mirror file is only created by `Player.showMirror` (when a change plays) or `Player.settle` (Skip to Latest). `settle` writes a missing file with `writeFile`, which fires `Created`, so a tab already showing "not found" reloads. The PLAY section of `it/restore.ts` relies on that.

`Player.ready()` snaps a mirror to the expected before text whenever the two differ, so playback is correct whatever a seeded mirror holds. Seeding only decides what the user sees before playback touches the file.

The design of `persist-timeline-across-reloads` listed "Restoring mirror tabs" as a non-goal. This change takes that item up.

## Goals / Non-Goals

**Goals:**
- A restored mirror tab whose file is in the restored timeline opens with the text it showed before the restart, never an error.
- No read from VS Code reaches the provider before seeding is done.
- A restored mirror tab with nothing behind it is closed, once, at activation.

**Non-Goals:**
- Restoring scroll position, selection, or which tab was active.
- Reseeding or closing tabs after Load Session or Clear Buffer. Those run in a live session, where mirror files already exist.
- Closing a mirror tab opened by hand later for a path with no file. The PLAY integration check opens one on purpose and expects Skip to Latest to fill it.
- Persisting the mirror files themselves. They are derived from the timeline.

## Decisions

### 1. What each mirror shows: `Timeline.mirrorStates()`

A new pure method returns `Map<relPath, { text, eol }>`. For each path:

- If it has events below the cursor (played), use the newest one's `after` and `eol`. A played `delete` gives `''`, which matches the empty mirror the player leaves after typing a delete.
- Otherwise, use the earliest event's `before` and `eol`. That is exactly the text `Player.ready()` expects before typing it, so resuming does not snap.

It reads only recorded event text, so the "before is captured at record time" rule holds. It lives in `timeline.ts` (no `vscode` import), so `test/timeline.test.ts` can cover it.

*Alternative considered:* `latestStates()` (newest event's after text for every path). It would show queued changes as already done, and resuming would visibly snap the mirror back before typing.

### 2. Seeding announces new files in one event, only for paths not yet present

After `historyRestored`, the extension passes every path from `mirrorStates()` to `mirror.seed`, which adds the files it does not hold yet and fires one batched `Created` event for them. The event means even a tab that somehow already resolved to "not found" reloads, the same thing `settle` relies on; batching keeps it to one round trip however many files the timeline holds. The CRLF encoding moves to a shared `mirrorBytes(text, eol)` in `mirrorFs.ts`, which the player calls too.

### 3. Readiness gate on the provider

`MirrorFileSystem` gets an internal gate promise and an `open()` method. While the gate is shut, `stat`, `readFile` and `readDirectory` return a promise that waits for `ready` and then answers from the map. Once open, they answer synchronously as today. The provider interface allows `Thenable` results. Writes, `has` and `store` are not gated: only the extension writes, and it writes after seeding.

`activate` opens the gate in a `finally` after `historyRestored`, so a failed restore never leaves reads hanging. As a backstop, the gate also opens after 10 s even if `historyRestored` has not settled, which covers a repository settings file whose `ready` never resolves, and it opens when the extension is disposed.

*Alternative considered:* relying on VS Code waiting for `activate()` to return before calling the provider. That is not guaranteed for `onFileSystem` activation, since the provider is usable as soon as it is registered, and `historyRestored` waits on file I/O.

### 4. Closing orphaned mirror tabs

Right after the gate opens, `closeOrphanMirrorTabs()` collects every tab in `vscode.window.tabGroups.all` whose input is a `TabInputText` with an `agent-typewriter` URI that `mirror.has` does not know, or a `TabInputTextDiff` with such a URI on either side. It closes them with one `tabGroups.close(tabs)` call (VS Code 1.85 API) and logs how many. Real-file tabs, snapshot diff tabs and other schemes are never touched. This runs once per activation. The function, and a `mirrorRestore` promise with the refilled and closed counts, are exposed on `AgentTypewriterApi` for the integration test.

Workbench tab state is restored before extensions activate, so restored mirror tabs are already in `tabGroups` when this runs, even ones VS Code has not resolved yet (inactive tabs load lazily).

*Alternative considered:* filling orphans with placeholder text. The tab would still look like a real mirror but hold nothing playback can use, and closing loses nothing the user can't get back.

## Risks / Trade-offs

- [A tab VS Code adds to `tabGroups` after the close pass stays in the error state] → Unlikely given the restore order. If it happens, Skip to Latest or replaying the file fills it, as today.
- [The 10 s backstop opens the gate before seeding when the repository file is very slow] → Tabs show "not found" as today, and seeding's `Created` event reloads them once it runs. No worse than the current behavior.
- [Seeding many files at activation] → One `Map.set` and one change event per recorded path, bounded by `historyLimit`. Text is already in memory from the restore.
- [Gated reads change provider timing for other callers] → Only during activation. The extension's own code doesn't read through the provider.
- [The integration harness cannot reproduce a tab restored during activation] → VS Code does not restore editors in the test launches. The gate is unit-tested against the mock, the reload launch checks the refill and the text tabs show, and orphan closing is checked through the API. A real restart is checked by hand.
- [The refill shows the text at the playback position, not always what was on screen] → After Replay Entire Buffer or a backward seek, a file not yet replayed shows its earliest before text, and a change cut off mid-typing comes back as its before text. That is what playback types from next, so resuming never snaps the mirror.

## Migration Plan

None. Nothing new is persisted. Rolling back brings the "file not found" tabs back.
