# Design

## Context

Playback control lives in `src/extension.ts` as commands: `togglePause`, `finishCurrent`, `catchUp`, `replayAll`, `replayFrom`, and `setSpeed`. They drive `Player` (`togglePause`, `finishCurrent`, `interrupt`, `snapToLatest`, `setSpeed`) and `Timeline` (`seek`, `seekToStart`, `seekToEnd`). Every command runs through a `register` wrapper that calls `refreshStatus()` afterward, and `refreshStatus()` also runs on every `Timeline.onDidChange`. Other sessions are changing the typing loop in `src/player.ts` and serialization in `src/timeline.ts` at the same time, so this change should not touch either file's behavior.

## Goals / Non-Goals

**Goals:**
- One panel to play, pause, seek, and set the speed, which stays in sync with playback.
- The panel calls the same code paths as the existing commands, so behavior does not fork.
- Presenter mode can drive the same seek and speed entry points.

**Non-Goals:**
- Showing a mirror's state at the slider position before playback reaches it. Seeking moves the cursor; the player already snaps a mirror to the change's before text when it starts typing it.
- Thumbnails, per-file markers, or time-based (rather than change-based) scrubbing.
- Removing the tree view or changing what it shows.

## Decisions

### A webview view in the Explorer, not a webview panel

A `WebviewViewProvider` registered as `agentTypewriter.scrubber` sits next to the timeline tree, so controls and the list are together and the panel survives editor layout changes. An editor-area `WebviewPanel` would compete with the mirror editors for space. The view is listed before the tree so it sits above it.

### Panel messages go through commands

The webview posts small messages (`togglePause`, `finishCurrent`, `skipToNext`, `catchUp`, `replayAll`, `seek`, `speed`). The provider turns each into `executeCommand` on the existing command. That keeps one implementation per action, and the `register` wrapper's error reporting and `refreshStatus()` apply to the panel too.

Two command changes support this:
- New hidden command `agentTypewriter.seek(seq)`: `timeline.seek(seq)` then `player.interrupt()`, without changing pause state. `replayFrom` stays as is (it also unpauses) for the tree's inline action. A seq past the newest change runs `catchUp` instead, so the end of the slider means "caught up".
- New command `agentTypewriter.skipToNext`: seeks to the change after the one being typed, or after the next queued one when nothing is typing. It uses the same seek path, so it keeps the pause state and past the newest change it skips to latest. The skipped change's mirror is left as it was; the player snaps a mirror to the before text of whatever change it plays next. Finish current stays separate: it completes the change instantly instead of dropping it.
- `agentTypewriter.setSpeed` accepts an optional number. With one, it sets the multiplier directly; without one, it shows the existing quick pick.

### Pure state and message validation in `src/scrubberState.ts`

`scrubberState(timeline, { paused, speed, watching })` returns a plain object: the list of changes (`seq`, `relPath`, `kind`), the slider index of the cursor, the playing seq, pause state, speed, watching, and the queue count. `parseScrubberMessage(raw)` returns a typed message or `undefined` for anything malformed (unknown type, a non-integer seq, a speed that is not a positive finite number). The module imports only types from `timeline.ts`, so `npm test` can cover it, and the extension never acts on unchecked webview input.

### Push state, throttled, from `refreshStatus()`

The provider exposes `refresh()`, and `refreshStatus()` calls it. Pause and speed changes do not fire `Timeline.onDidChange`, but they all go through commands, which call `refreshStatus()`. `refresh()` coalesces calls into one `postMessage` per 100 ms, like the tree view's `refreshSoon`. The webview also posts `ready` on load, and the provider answers with the full state, which covers the view being hidden and shown again without `retainContextWhenHidden`.

### Slider indexes changes, not seqs

The slider's range is `0..N`, where `N` is the number of changes in the buffer. Index `i < N` means "next to play is the i-th change" and maps to its seq; `N` means caught up. Using indexes rather than seqs keeps the slider stable when old changes are trimmed from the buffer. While the user drags, the webview ignores incoming slider positions so updates do not fight the drag, and it seeks once on release.

### Locked-down HTML, no build step

The HTML is a template string with inline CSS and script, both tagged with a fresh nonce. The CSP is `default-src 'none'; style-src 'nonce-…'; script-src 'nonce-…'`. `localResourceRoots` is empty. Icons are Unicode glyphs and colors come from VS Code theme variables, so no codicon font or bundler is needed. The track's played/pending fill is set through the CSSOM (`element.style`), which the CSP allows.

## Risks / Trade-offs

- [Seeking while paused leaves the mirror showing the old position until play resumes] → Accepted for now (see Non-Goals). The label under the slider says which change is next.
- [Large buffers make each state message bigger] → The buffer is capped by `historyLimit` (500 by default), each entry is three short fields, and messages are throttled to 10 per second.
- [Removing title-bar buttons hides actions people used] → They stay as commands in the palette, and the panel sits directly above the tree.
- [Conflicts with parallel work in `package.json` and `src/extension.ts`] → Changes are additive: a new view, a new command, and a trimmed menu block.
