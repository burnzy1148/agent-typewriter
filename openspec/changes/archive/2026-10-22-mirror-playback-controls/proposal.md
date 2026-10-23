# Proposal

## Why

Playback can only be controlled from the Playback panel in the sidebar and the status bar. While watching a replay, the user's eyes are on the mirror tab being typed into, and the sidebar is often collapsed for screen recordings. Controls on that tab let the user pause, skip, or catch up without looking away from the replay.

## What Changes

- The mirror tab for the playback file (the change being typed, or else the most recently played one) shows playback buttons in its editor title bar: replay all, play/pause, finish current, skip to next, and skip to latest. Other tabs, mirror or real, don't show them.
- The play/pause button shows play while paused and pause while playing, and pressing it always does what its icon shows, even when the state changed just before the click.
- The playback mirror document shows a CodeLens row above its first line. The row has the same controls as clickable text, plus a readout of what is playing, the position in the buffer, the queued count, and the speed. Clicking the speed picks a new one; clicking the readout reveals the Playback panel.
- The row updates as changes are recorded and played, and when playback is controlled from anywhere else.
- New setting `agentTypewriter.mirrorStatusRow` (default `true`) turns the CodeLens row off, for example to keep it out of a screen recording. The title bar buttons can already be hidden through VS Code's own title bar context menu. The row is also hidden when the user's `editor.codeLens` is off.
- New commands `agentTypewriter.pause` and `agentTypewriter.resume` back the two states of the play/pause button. They are hidden from the command palette. `togglePause` stays as is.
- `skipToNext` gets an icon.

## Capabilities

### New Capabilities
None.

### Modified Capabilities
- `playback-controls`: adds requirements for controls on the playback mirror tab (title bar buttons and the CodeLens status row) and for which mirror counts as the playback mirror.

## Impact

- `package.json`: `editor/title` menu entries scoped to the playback mirror, the `pause`/`resume` commands (hidden from the palette), a `skipToNext` icon, and the new setting.
- `src/player.ts`: exposes the playback mirror's path and fires an event when it changes.
- New `src/mirrorControls.ts`: the CodeLens provider and the context keys the title bar entries use (`agentTypewriter.paused`, `agentTypewriter.playbackMirror`).
- `src/extension.ts`: registers the pause/resume commands and the provider, and drives refreshes from `refreshStatus`.
- `src/config.ts`, `src/repoSettings.ts`, `schemas/agent-typewriter.schema.json`, README: the new setting.
- Unit tests for the readout text. An integration section for the context keys, the lenses, and pause/resume.
- Nothing is written to real files. The lenses and buttons only appear on `agent-typewriter:` documents.
