# Design

## Context

Playback controls live in the Playback webview (`src/scrubberView.ts`) and the status bar. Both run the existing commands (`togglePause`, `finishCurrent`, `skipToNext`, `catchUp`, `replayAll`, `setSpeed`), and `refreshStatus` in `src/extension.ts` refreshes them whenever the timeline changes or a command finishes.

By default the player opens mirror tabs with `preserveFocus: true` in a column beside the user's editor. So the playback mirror is usually visible but not the active editor. Mirror URIs are `agent-typewriter:/<relPath>`. The extension targets VS Code `^1.85.0`.

## Goals / Non-Goals

**Goals:**
- Controls on the playback mirror tab, defined in `specs/playback-controls/spec.md`, that run the same commands as the panel, with no separate copy of the playback logic.
- One source for the "what is playing" text, shared by the panel and the status row.

**Non-Goals:**
- A seek slider on the mirror tab. Neither the title bar nor CodeLens can host one, so seeking stays in the panel and the timeline view.
- Controls on non-playback mirror tabs, or on diff views of recorded changes.
- Any change to the status bar item or the panel's layout.

## Decisions

### Scope the title bar entries with a context key the player sets

The `editor/title` entries use `resourceScheme == agent-typewriter && resourcePath in agentTypewriter.playbackMirror`. The extension sets `agentTypewriter.playbackMirror` to a one-element array holding the playback mirror's path, or to an empty array when there is none.

`editor/title` `when` clauses are evaluated against each editor group's own `resource`. That works even when the mirror is in a group that doesn't have focus. A key based on the active editor (`activeEditor`, or a flag flipped in `onDidChangeActiveTextEditor`) would hide the buttons in exactly the default setup, where focus stays in the user's own editor. A `when` clause can't compare two context keys with `==`, and `in` against an array value is the supported form (available well before 1.85).

### Player owns "which mirror is the playback mirror"

`Player` gets a `playbackRelPath` getter and an `onDidChangePlaybackMirror` event. They are updated as soon as `showMirror` returns in `play()` and in `snapToLatest()`. That happens before the file-switch delay, so the controls move to the new tab when it is shown, not after the pause.

`lastRelPath` stays as it is, because it also decides whether a switch delay applies. Deriving the mirror in `extension.ts` from the timeline's playing event was rejected: between changes nothing is playing, and the extension would have to re-create the player's "last played" memory.

### Separate idempotent `pause` and `resume` commands

The title bar shows `agentTypewriter.pause` (`$(debug-pause)`) when `!agentTypewriter.paused`, and `agentTypewriter.resume` (`$(play)`) when it is paused. Each command only moves playback toward its own state. A click that arrives after the state changed elsewhere then does what the icon showed (see the "Press after the state changed" scenario), instead of flipping playback back.

Using `togglePause` with a state-dependent icon was rejected for that reason. Menu-level `toggled` icons aren't available for `editor/title` in the targeted API. Both new commands are hidden from the palette with `when: false`, because `togglePause` already covers that.

`agentTypewriter.paused` is set from `refreshStatus`, and `setContext` is only called when the value changes. `agentTypewriter.hasChanges` hides replay all, finish, next, and latest while the buffer is empty, matching the row. `Player.setPaused` replaces the toggle-if-needed pattern the existing replay, load, and restore paths used.

### CodeLens provider scoped to the playback mirror

New `src/mirrorControls.ts` registers a provider with `{ scheme: MIRROR_SCHEME }`. It returns lenses only for the document whose URI is the playback mirror's, and only while `mirrorStatusRow` is on. All lenses sit on `Range(0, 0, 0, 0)`, so VS Code draws them as one row above line 1, and they are decoration only, so the document text is untouched. In order:

| Lens | Command |
|---|---|
| `$(debug-pause) Pause` / `$(play) Play` | `pause` / `resume` |
| `$(zap) Finish` | `finishCurrent` |
| `$(arrow-right) Next` | `skipToNext` |
| `$(debug-continue) Latest` | `catchUp` |
| `2x` | `setSpeed` (no argument, so it opens the quick pick) |
| readout, e.g. `Typing #12 src/a.ts · 3 queued · 4 / 12` | `agentTypewriter.scrubber.focus` |

The provider fires `onDidChangeCodeLenses` from `refreshStatus` and from `onDidChangePlaybackMirror`. VS Code restarts its CodeLens timer on every change event and asks again only after 250 ms without one, so events come at most every 300 ms, and only when the row's text, the playback mirror, or the setting changed. Events every 100 ms during a burst of recorded changes would keep the row from updating at all. The readout escapes `$(name)` in file names, which CodeLens would otherwise draw as an icon. VS Code's own `editor.codeLens: false` already hides lenses, so nothing extra is needed for that part of the spec.

A webview or HTML overlay on the editor isn't possible through the extension API. Decorations with `before` content can't be clicked. That makes CodeLens the only clickable in-editor option.

### Move the status text into `scrubberState.ts`

The panel currently builds its label in its inline script (`statusText`). That logic moves to an exported, unit-tested `describePlayback(state)` in `src/scrubberState.ts`, which returns the label and the position text. `ScrubberState` carries both strings. The webview shows them when the user isn't dragging the slider, and the lens readout uses the same function. The panel's text doesn't change. Keeping a second copy for the lens was rejected, because the two would drift.

### Icons

`skipToNext` gets `$(arrow-right)`, and the new commands get `$(debug-pause)` and `$(play)`. Title bar order matches the panel: replay all, play/pause, finish, next, latest, all in the `navigation` group so they show as icons rather than in the overflow menu.

### Setting

`agentTypewriter.mirrorStatusRow` (boolean, default `true`) goes in `package.json`, `Settings`/`readSettings`, `REPO_SETTING_KINDS`, and the JSON schema, which keeps the settings sync test passing. `applySettingsChange` already ends with `refreshStatus`, and that refreshes the lenses, so no special handling is needed.

## Risks / Trade-offs

- [The row lags behind typing] VS Code restarts its CodeLens timer on every edit and only asks again after 250 ms without edits, so while a change is being typed the row keeps what it showed when typing started. On a tab switch it shows the row it last got for that file. → The player marks the playback mirror before showing its tab, so the request made as the tab opens gets the row. The readout catches up at pauses and between changes; during fast catch-up a file's first row can wait for a pause. The status bar and panel stay live. Showing the row on every mirror would avoid the missing first row, and was declined to keep the controls on the playback tab only.
- [The row moves the mirror's content down one line, and it shows up in screen recordings] → `mirrorStatusRow` turns it off. The README's "The panels" section says so.
- [Five extra icons crowd the mirror's title bar] → They only appear on the one playback mirror tab, and VS Code lets the user hide any of them from the title bar's context menu.
- [The stale context key after Clear Buffer] Clearing doesn't close mirror tabs. → The playback mirror stays until something else plays, because the tab still shows that file; with the buffer empty only play or pause shows there. Loading a session forgets the playback mirror, since the loaded changes may not touch that file.
- [`resourcePath in` matching on Windows] Mirror paths are built by `MirrorFileSystem.uriFor` with forward slashes on every platform, and the key is set from the same `Uri.path`. → The integration test runs on Windows CI.
