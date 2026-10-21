# Tasks

## 1. State and messages

- [x] 1.1 Create `src/scrubberState.ts` with `scrubberState(timeline, { paused, speed, watching })` and `parseScrubberMessage(raw)`. Verify: `npm run typecheck` passes and the module imports nothing from `vscode`.
- [x] 1.2 Add `test/scrubberState.test.ts`: slider index at start, middle, and caught up; playing seq and queue count; trimmed buffer; every valid message type; malformed messages (unknown type, non-integer seq, zero, negative, or non-numeric speed). Verify: `npm test` passes.

## 2. Commands

- [x] 2.1 Add hidden command `agentTypewriter.seek(seq)` in `src/extension.ts`: seek and interrupt without changing pause state; a seq past the newest change runs `catchUp`. Hide it from the command palette. Verify: `npm run typecheck` passes.
- [x] 2.2 Let `agentTypewriter.setSpeed` take an optional multiplier and set it without the quick pick. Verify: `npm run typecheck` passes.
- [x] 2.3 Add command `agentTypewriter.skipToNext`: seek to the change after the playing one (or after the cursor when idle), through the same path as `seek`. Verify: `npm run typecheck` passes.

## 3. Panel

- [x] 3.1 Create `src/scrubberView.ts`: a `WebviewViewProvider` that serves nonce-locked HTML, posts throttled state, answers `ready`, and runs validated messages as commands. Verify: `npm run typecheck` passes.
- [x] 3.2 Register the `agentTypewriter.scrubber` webview view in `package.json` above the timeline tree, wire the provider in `src/extension.ts`, refresh it from `refreshStatus()`, and expose it on the activation API for tests. Verify: `npm run build` succeeds.
- [x] 3.3 Trim the timeline's `view/title` menu to start/stop in the navigation group plus the existing overflow items. Verify: no `togglePause`, `finishCurrent`, `catchUp`, or `replayAll` entries remain under `view/title`.
- [x] 3.4 Document the panel in README.md. Verify: README mentions the Playback panel and its controls.

## 4. Integration verification

- [x] 4.1 Extend `it/suite.ts`: open the panel, check its HTML's CSP, then drive seek-while-paused, seek-to-end, skip to next, and speed through the panel's message handler and check timeline and player state. Verify: `npm run it` passes.
- [x] 4.2 Run `npm run typecheck && npm test && npm run build`. Verify: all succeed and the planner fuzz test still passes.
- [x] 4.3 Check the panel by hand: play, pause, skip to next, click and drag to seek, and speed, in the real panel HTML with a stubbed VS Code API in a browser (the Extension Development Host could not be driven without taking over the desktop). The trimmed title bar is checked in `package.json`.

## Workflow follow-up

- Archive the change on the PR branch once CI is green, then `bd close at-2i9.1` after merge.
