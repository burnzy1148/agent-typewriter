# Tasks

## 1. What each mirror shows

- [x] 1.1 Add `Timeline.mirrorStates()` to `src/timeline.ts`, returning per path the newest played change's after text and eol, or the earliest change's before text and eol when none was played. Verify with unit tests in `test/timeline.test.ts` covering: a played file, a file with only queued changes, a file with played and queued changes (newest played after wins), a played delete giving `''`, a CRLF event keeping `\r\n`, and an empty timeline giving an empty map.

## 2. Mirror filesystem

- [x] 2.1 In `src/mirrorFs.ts`, add a shared `mirrorBytes(text, eol)` helper and have the player use it, and a `seed(files)` method that adds missing files in one `Created` event. Add a readiness gate: an internal promise and an `open()` method. While the gate is shut, `stat`, `readFile` and `readDirectory` wait for it, then answer from the map; once open they answer synchronously as now. Verify with unit tests in `test/mirrorFs.test.ts` (reads pending until `open()`, then answered, FileNotFound for a missing file, synchronous once open; `seed` adds only new files in one event, with CRLF), and `npm run typecheck` and `npm test` pass.

## 3. Activation wiring

- [x] 3.1 In `src/extension.ts`, after `timeline.restore` in `historyRestored`, seed every path from `mirrorStates()` with `mirror.seed`. Open the gate in a `finally` after `historyRestored`, with a 10 s backstop timer and on dispose, and log how many mirrors were seeded. Expose a `mirrorRestore` promise with the refilled and closed counts. Verify `npm run typecheck` passes.
- [x] 3.2 Add `closeOrphanMirrorTabs()`: close every `TabInputText` tab with an `agent-typewriter` URI that `mirror.has` does not know, and every `TabInputTextDiff` with one on either side, in one `tabGroups.close` call, and log the count. Call it once right after the gate opens, and expose it on `AgentTypewriterApi` for tests. Verify `npm run typecheck` passes.

## 4. Integration checks

- [x] 4.1 At the end of `it/suite.ts` (section 18), make sure mirror tabs are open for at least one played file, a CRLF file if the suite has one, and a file whose newest change is queued behind a played one, and record their relative paths and the text and line ending each tab shows in `IT_EXPECT`. At the top of `it/restore.ts`, before anything plays, assert `mirrorRestore` refilled at least those files, open each tab (`vscode.open`), then assert each document reads its expected text and line ending with no error. Check that resuming types the queued change into its tab. Verify `npm run it` passes.
- [x] 4.2 In `it/restore.ts`, open a mirror tab and a compare tab for paths not in the timeline, and a real-file tab, call `api.closeOrphanMirrorTabs()`, and assert both orphan tabs are closed and the real-file tab is still open. Place it so the PLAY section's hand-opened `play/reload2.ts` tab is not touched. Verify `npm run it` passes locally, and on CI on Ubuntu and Windows. Done in `it/restore.ts` section 2b, which runs before the PLAY section opens `play/reload2.ts` and landed with #29.

## 5. Docs

- [x] 5.1 Add a line under `## Unreleased` in `CHANGELOG.md`: mirror tabs left open across a restart reopen with their last text, and mirror tabs with no recorded history are closed instead of showing "file not found". Verify by reading the entry.

## Workflow follow-up

- Archive on the PR branch once tasks are done and CI is green, then merge.
