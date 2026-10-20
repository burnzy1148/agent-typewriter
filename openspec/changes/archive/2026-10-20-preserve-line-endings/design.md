# Design

## Context

`Recorder.readText` runs `normalizeEol` on every file it reads, so snapshots and `ChangeEvent.before/after` are always LF. The planner's offsets index into that LF text. The player hands those offsets straight to `doc.positionAt()`, which counts each CRLF break as two characters. That is only correct while the mirror document is LF. Today mirrors are created from LF bytes, so VS Code usually picks LF. A file with no line break yet takes `files.eol`, though, which can be CRLF on Windows. Nothing ever sets a mirror to CRLF on purpose. See proposal.md for motivation and specs/mirror-documents/spec.md for the required behavior.

## Goals / Non-Goals

**Goals:**
- Keep LF-normalized before/after text as the planning model, so `planHunks` and its fuzz-tested round-trip guarantee stay the same.
- Make every player edit independent of line ending by mapping LF offsets to positions explicitly.

**Non-Goals:**
- Preserving mixed line endings exactly. A VS Code document has one line ending, so mixed files use the majority.
- Classic Mac lone-CR files. `normalizeEol` already turns `\r` into `\n`, and they replay as LF.
- The "Show Diff" snapshot views, which keep showing LF text.

## Decisions

### Store the line ending on the event; keep the text LF

Add `eol: '\n' | '\r\n'` to `ChangeEvent`/`NewChangeEvent`. The recorder detects it from the raw bytes before normalizing them, and keeps it on the snapshot alongside the text. Snapshots become `{ text, eol }`. A `modify` or `create` event takes the after file's line ending. A `delete` takes the snapshot's. A line-ending-only rewrite updates the snapshot's `eol` but records nothing, because the normalized text is unchanged.

Alternative considered: store raw CRLF text and plan on it. Rejected. The planner, the typing loop's `'\n'` checks and the line-start indent logic would all have to understand `\r\n`. Typing could also split a `\r\n` pair across chunks. The fuzz invariant would have to be re-proven too.

### Detect the line ending with a pure `detectEol(raw)` in `planner.ts`

It returns CRLF when CRLF breaks outnumber LF-only breaks, and LF otherwise, including for text with no breaks. It lives next to `normalizeEol`, so `npm test` can cover it without `vscode`.

### Set the mirror's line ending explicitly before each change

In `play()`, after `showMirror`, if `doc.eol` differs from the event's, apply `editBuilder.setEndOfLine(...)`. `snapToLatest` adds `TextEdit.setEndOfLine` to its `WorkspaceEdit`. VS Code converts inserted `\n` to the document's line ending, so `insert`/`replace` calls can keep passing LF text.

### Map LF offsets to positions through one helper

Add a pure `lfOffsetToLineCol(lfText, offset)` and a player wrapper `posAt(doc, lfOffset)`. The wrapper uses `doc.positionAt` directly when `doc.eol` is LF (the fast path, same as today). For CRLF it maps using the document's normalized text. Every `doc.positionAt(<planner offset>)` call in `player.ts` goes through `posAt`. That covers `typeHunk`, `deleteText`, `typeText` and the flash range, plus the delete branch in `play()`. Text comparisons (`getText() !== e.before/after`) compare `normalizeEol(doc.getText())`.

Alternative considered: always force mirrors to LF and only set CRLF after playback. Rejected. The status bar would flip mid-replay, and the spec requires the line ending during typing.

## Risks / Trade-offs

- [Normalizing a CRLF mirror's text on every typing tick costs O(file size)] → It is limited to CRLF documents, and files are capped by `maxFileSizeKB` (512 KB by default). If profiling shows a cost, cache the normalized text per edit.
- [The integration suite can't run on macOS through `npm run it`, which needs xvfb] → The CRLF scenario is added to `it/suite.ts` and can be run on macOS with `node .it-out/runTest.js` after the build step. CI (`at-net.1`) will run it on Linux.
- [Events from before this change have no `eol`] → The timeline is in memory only and is cleared on reload, so there's no migration. The player treats a missing `eol` as LF.
