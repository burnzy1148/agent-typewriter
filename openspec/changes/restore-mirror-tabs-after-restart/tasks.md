# Tasks

## 1. What each mirror shows

- [x] 1.1 Add `Timeline.mirrorStates()` to `src/timeline.ts`, returning per path the newest played change's after text and eol, or the earliest change's before text and eol when none was played. Verify with unit tests in `test/timeline.test.ts` covering: a played file, a file with only queued changes, a file with played and queued changes (newest played after wins), a played delete giving `''`, a CRLF event keeping `\r\n`, and an empty timeline giving an empty map.

## 2. Mirror filesystem

- [x] 2.1 In `src/mirrorFs.ts`, add a shared `mirrorBytes(text, eol)` helper and have `Player.bytes` use it. Add a readiness gate: a `ready` promise and an `open()` method. While the gate is shut, `stat`, `readFile` and `readDirectory` wait for it, then answer from the map; once open they answer synchronously as now. Verify `npm run typecheck` and `npm test` pass.

## 3. Activation wiring

- [x] 3.1 In `src/extension.ts`, after `timeline.restore` in `historyRestored`, seed each path from `mirrorStates()` with `mirror.writeFile(MirrorFileSystem.uriFor(rel), mirrorBytes(text, eol))`, skipping paths `mirror.has` already knows. Open the gate in a `finally` after `historyRestored`, with a 10 s backstop timer, and log how many mirrors were seeded. Verify `npm run typecheck` passes.
- [x] 3.2 Add `closeOrphanMirrorTabs()`: close every `TabInputText` tab with the `agent-typewriter` scheme that `mirror.has` does not know, in one `tabGroups.close` call, and log the count. Call it once right after the gate opens, and expose it on `AgentTypewriterApi` for tests. Verify `npm run typecheck` passes.

## 4. Integration checks

- [x] 4.1 At the end of `it/suite.ts` (section 18), make sure mirror tabs are open for at least one played file, a CRLF file if the suite has one, and a file whose newest change is queued behind a played one, and record their relative paths and expected text in `IT_EXPECT`. At the top of `it/restore.ts`, before anything plays, open any of those tabs VS Code did not restore (`vscode.open`), then assert each document reads its expected text and line ending with no error. Check that resuming types the queued change into its tab. Verify `npm run it` passes.
- [ ] 4.2 In `it/restore.ts`, open a mirror tab for a path not in the timeline and a real-file tab, call `api.closeOrphanMirrorTabs()`, and assert the mirror tab is closed and the real-file tab is still open. Place it so the PLAY section's hand-opened `play/reload2.ts` tab is not touched. Verify `npm run it` passes locally, and on CI on Ubuntu and Windows.

## 5. Docs

- [x] 5.1 Add a line under `## Unreleased` in `CHANGELOG.md`: mirror tabs left open across a restart reopen with their last text, and mirror tabs with no recorded history are closed instead of showing "file not found". Verify by reading the entry.

## Workflow follow-up

- Archive on the PR branch once tasks are done and CI is green, then merge.
