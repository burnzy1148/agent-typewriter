# Design

## Context

at-dqb.1 added the session format (`toSession`, `parseSession`, `Timeline.restore` in `src/timeline.ts`) and `TimelineStore` in `src/persistence.ts`, which gzips sessions into workspace storage. `Timeline.restore` renumbers events after seqs already handed out, maps the cursor by position, and applies the current limit. Loading a file reuses all of it. The player pauses through `togglePause`, and `interrupt()` stops a change being typed.

## Goals / Non-Goals

**Goals:**
- A session file is the same format as workspace persistence, so one parser and one version policy cover both.
- Loading never touches real files and never starts typing on its own.

**Non-Goals:**
- Merging a file into the current buffer. Load replaces it.
- Stopping or changing recording on load. If watching, new changes are appended after the loaded ones, as for any buffer.
- Showing which workspace a session came from. The `uri` field is kept for information only. Replay uses `relPath`, which names mirror documents.

## Decisions

### 1. File encoding in `src/persistence.ts`

`sessionToBytes(session, { gzip })` and `sessionFromBytes(bytes)`. Saving writes plain JSON, which is readable, diffable and easy to attach to a review. Loading accepts plain JSON or gzip, detected by the `1f 8b` magic bytes, so a copy of the workspace storage file also loads. `TimelineStore` switches to these helpers so there is one decoder. Explicit saves are not capped. The 64 MB cap belongs to the automatic save.

*Alternative considered:* gzip by default. Files are smaller, but a reviewer could no longer open one in an editor. A session is mostly source text and is rarely large.

### 2. Commands in `src/extension.ts`

- `agentTypewriter.saveSession(uri?)`: empty buffer → information message. No `uri` → `showSaveDialog` with `defaultUri` `~/agent-typewriter-<yyyy-mm-dd-hhmm>.json` and a JSON filter. Writes with `vscode.workspace.fs.writeFile`, so remote targets work. Calls `recorder.drainHeld()` first so held changes are included. The dialog starts in the home folder because a file saved in the watched workspace would itself be recorded as a create (when its extension passes the filters) and could end up in the session. If the user picks a workspace folder anyway, that is their choice.
- `agentTypewriter.loadSession(uri?)`: no `uri` → `showOpenDialog` (JSON and gz filters). Reads with `vscode.workspace.fs.readFile`, decodes, parses. Errors go through the `register` wrapper's error message, with `SessionFormatError` text such as "not an Agent Typewriter session". Interactive only: a modal confirmation when the buffer is not empty, and the `historyLimit` choice when the session is larger. Then: pause the player if needed, `timeline.restore(events, firstSeq)` so every change is pending, `player.interrupt()`, and a status-bar message with the count.
- Passing a `uri` skips the dialogs and the confirmation. The session is then loaded within the current `historyLimit`, with a warning if changes were left out. That is for tests and scripts.

### 3. History limit choice

A modal with **Raise historyLimit to N** and **Load newest M**. Raising calls `updateSetting('historyLimit', N)` and `timeline.setLimit(N)` directly before restoring, so the configuration event arriving later is a no-op.

### 4. Persistence interplay

A load changes the timeline, so `TimelineStore` saves it into workspace storage as usual, and a reload brings the loaded session back.

## Risks / Trade-offs

- [A session file from someone else] → Its text only ever goes into in-memory mirror documents and diff views. `parseSession` validates every field's type and each kind. Paths become mirror URIs, which are not real files.
- [A very large file] → It is read whole into memory, the same order of size as the buffer that produced it. Loading is user-initiated, and the history limit choice bounds what stays in the buffer.
- [Saving into the watched workspace records the file] → The dialog defaults to the home folder. The README says so.
