# Tasks

## 1. Shared status text

- [x] 1.1 Add `describePlayback(state)` to `src/scrubberState.ts`, returning the label and position text the panel shows today (waiting, not watching, typing/paused in, next/paused before, caught up, queued suffix). Carry both strings on `ScrubberState` and have the webview use them when the slider isn't held. Verify with new cases in `test/scrubberState.test.ts` for each label form, and confirm `npm test` passes
- [x] 1.2 Check that the existing scrubber integration section still passes with `npm run it`, so the panel text is unchanged

## 2. Playback mirror and commands

- [x] 2.1 Add `playbackRelPath` and `onDidChangePlaybackMirror` to `Player`, updated right after `showMirror` in `play()` and in `snapToLatest()`. Verify with a typecheck (`npm run typecheck`)
- [x] 2.2 Register idempotent `agentTypewriter.pause` and `agentTypewriter.resume` commands in `src/extension.ts`. Contribute them in `package.json` with `$(debug-pause)` and `$(play)` icons, hidden from the palette. Give `skipToNext` the `$(arrow-right)` icon. Verify the commands don't appear in the palette
- [x] 2.3 Set the context keys `agentTypewriter.paused` (only when the value changes) and `agentTypewriter.playbackMirror` (`[uri.path]` or `[]`) from `refreshStatus` and the player's event. Verify with a typecheck

## 3. Title bar buttons

- [ ] 3.1 Add `editor/title` entries in the `navigation` group, in the order replay all, pause/resume, finish current, skip to next, skip to latest, each with `resourceScheme == agent-typewriter && resourcePath in agentTypewriter.playbackMirror` (plus `!agentTypewriter.paused` / `agentTypewriter.paused` for pause/resume). Verify by hand with `F5`: the buttons appear on the playback mirror tab only, move to the next file's tab, stay after catching up, don't appear on the real file's tab, and switch between play and pause when paused from the status bar

## 4. Status row

- [x] 4.1 Add the `agentTypewriter.mirrorStatusRow` setting (default `true`) to `package.json`, `config.ts`, `REPO_SETTING_KINDS`, and `schemas/agent-typewriter.schema.json`. Verify the settings sync test passes with `npm test`
- [ ] 4.2 Add `src/mirrorControls.ts` with a CodeLens provider for the mirror scheme. It returns the design's lens row on line 0 for the playback mirror only, and nothing when the setting is off. It fires `onDidChangeCodeLenses`, coalesced to 100 ms, from `refreshStatus` and the player's event. Register it in `extension.ts`. Verify by hand that the row updates while typing, when a change is recorded, when paused from the panel, and when the setting is toggled
- [x] 4.3 Document the title bar buttons, the status row, and `mirrorStatusRow` in the README ("The panels" and "Settings"), including turning the row off for screen recordings. Verify that the README settings table lists every contributed setting

## 5. Integration checks

- [ ] 5.1 Add an integration section to `it/suite.ts`. Check that after a change plays, `executeCommand('vscode.executeCodeLensProvider', mirrorUri)` returns the row with the readout naming that change. Check that the provider returns no lenses for another mirror or for the real file. Check that `pause` while paused and `resume` while playing leave the state as is. Check that `mirrorStatusRow: false` yields no lenses. Check that the mirror text equals the after text. Verify that `npm run it` passes locally and on CI (Ubuntu and Windows)

## Workflow follow-up

- Archive on the PR branch once tasks are done and CI is green, then merge.
