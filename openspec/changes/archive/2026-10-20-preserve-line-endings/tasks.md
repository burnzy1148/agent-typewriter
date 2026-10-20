# Tasks

## 1. Line-ending primitives

- [x] 1.1 Add `detectEol(raw)` to `src/planner.ts` (CRLF only when CRLF breaks outnumber LF-only breaks; LF otherwise and for text with no breaks) and add `test/eol.test.ts` covering all-LF, all-CRLF, mixed majority each way, a tie, and no breaks. Verify: `npm test` passes.
- [x] 1.2 Add a pure `lfOffsetToLineCol(lfText, offset)` (in `src/planner.ts` or a new vscode-free module) with unit tests for offset 0, the end of a line, the start of the next line, and the end of the text. Verify: `npm test` passes.

## 2. Recording

- [x] 2.1 Add `eol: '\n' | '\r\n'` to `ChangeEvent`/`NewChangeEvent` in `src/timeline.ts` and update the test helpers in `test/timeline.test.ts`. Verify: `npm run typecheck && npm test` pass.
- [x] 2.2 In `src/recorder.ts`, make `readText` return `{ text, eol }` (detected before normalizing), store `{ text, eol }` snapshots, and pass `eol` into `record()`: the after file's for modify/create, the snapshot's for delete. A line-ending-only rewrite updates the snapshot's `eol` without recording. Verify: `npm run typecheck` passes and the baseline, create, modify and delete paths each set `eol`.

## 3. Playback

- [x] 3.1 In `src/player.ts`, add `posAt(doc, lfOffset)` (`doc.positionAt` when `doc.eol` is LF, `lfOffsetToLineCol` on the normalized text otherwise) and route every planner-offset `positionAt` call through it. Verify: grep shows no `positionAt(` taking a planner offset other than inside `posAt`.
- [x] 3.2 Compare mirror text with `normalizeEol(doc.getText())` at each `getText()` comparison in `play()` and `snapToLatest()`. Verify: `npm run typecheck` passes.
- [x] 3.3 Set the mirror's line ending from `e.eol` (missing means LF) before typing in `play()` and in `snapToLatest()` (`TextEdit.setEndOfLine`). Verify: `npm run typecheck` passes.
- [x] 3.4 Add a CRLF scenario to `it/suite.ts`: write a CRLF file, modify a middle line, wait for replay, then assert the mirror's `eol` is CRLF and its normalized text equals the file's normalized text. Verify: `npm run build` plus bundling `it/` succeeds, and on macOS `node .it-out/runTest.js` passes.

## 4. Integration verification

- [x] 4.1 Run `npm run typecheck && npm test && npm run build`. All succeed, and the planner fuzz test still passes.
- [x] 4.2 Manually replay a CRLF file in the Extension Development Host. The status bar shows CRLF on the mirror tab and edits land on the right lines.

## Workflow follow-up

- Archive the change, then `bd close at-net.3`.
