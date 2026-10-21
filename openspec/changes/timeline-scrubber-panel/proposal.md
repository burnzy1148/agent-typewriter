# Proposal

## Why

Playback is controlled by a row of small title-bar icons on the timeline view (pause, finish current, skip to latest, replay all) plus a quick pick for speed. Nothing shows where playback is in the buffer, and there is no way to drag to a point. A scrubber panel works like a media player: one place to play, pause, seek, and change speed. It is also the control surface presenter mode (`at-2i9.2`) will build on.

## What Changes

- New webview view, "Playback", next to the timeline tree in the Explorer. It has:
  - a play/pause button,
  - buttons for replay from the start, finish the current change, skip to the next change, and skip to latest,
  - a slider over the recorded changes that seeks when released, with a label naming the change at the slider position,
  - a speed picker (0.5x to 5x),
  - a line showing what is playing and how many changes are queued.
- The panel follows playback live: the slider, play/pause state, speed, and queue count update as changes are recorded and played, and when the same controls are used from commands or the status bar.
- Seeking from the panel keeps the current play/pause state. Seeking past the newest change works like skip to latest.
- The timeline view's title bar keeps only start/stop watching. Pause, finish current, skip to latest, and replay all move to the panel. They stay available as commands.
- The webview runs under a strict Content Security Policy: no remote content, and only its own nonce-tagged script and style.

## Capabilities

### New Capabilities

- `playback-controls`: how the user plays, pauses, seeks, and sets the speed of replay, and what the scrubber panel shows.

### Modified Capabilities

None.

## Impact

- New `src/scrubberView.ts`: the webview view provider and its HTML.
- New vscode-free `src/scrubberState.ts`: builds the state sent to the panel and validates messages from it, so both are unit tested.
- `src/extension.ts`: registers the view, adds a hidden `agentTypewriter.seek` command and an `agentTypewriter.skipToNext` command, lets `agentTypewriter.setSpeed` take a multiplier argument, and refreshes the panel with the status bar.
- `package.json`: the new view, the new command, and a trimmed `view/title` menu.
- `src/player.ts` and `src/timeline.ts`: no behavior changes. At most a small read-only accessor if the panel needs one.
- `test/` and `it/suite.ts`: unit tests for state and message validation, and an integration check of seek and speed through the panel.
