# Proposal

## Why

Once the person closes the Agent Typewriter pane, or Claude Code leaves it unplaced, playback carries on with nothing on screen to say so. The person can't tell that edits are still being typed, how many are waiting, or how to get the pane back short of typing `/typewriter`. The at-o3z.8 mockup's Desktop board (pane closed) answers this with a band above the prompt and a status entry under it, and at-o3z.18 carries both into the plugin.

## What Changes

- **A band above the prompt while the pane is out of view.** In the desktop app, while the pane is closed or open but not placed, and a change is being typed or waits to play, the plugin draws one row in the band directly above the prompt. It goes away when the pane is placed again, or when nothing is typing or queued.
- **What the band says.** The same line as the status entry: the shown change's file name, its change number, whether playback is typing or paused (or paused with that change cued next), and how many changes are queued.
- **Three controls on the band.** Pause (Resume while paused), Skip to latest, and Open pane, which opens the pane as `/typewriter` does. While the band holds the keyboard, `p`, `l` and `o` press them. `p` and `l` are the pane's own hotkeys for the same controls.
- **A status entry.** From the session's first recorded change, the plugin keeps one status entry under the prompt with that line, whether the pane is open or not, ending in "up to date" once nothing is typing or queued. In a session that also draws on the terminal, the plugin keeps no status entry, because Claude Code's status entries are not per surface and the terminal is left to the VS Code extension.

Out of scope, and kept possible:
- The VS Code surface's band. Claude Code raises the band above the prompt only on the terminal and desktop surfaces, so in VS Code only the status entry carries this state.
- The terminal, where the plugin still draws nothing.
- Lane colors and a per-lane queued count on the band (at-o3z.15). The count here is the pane's: every recorded change waiting to play.
- Treating a pane that is placed but hidden behind another pane's tab as out of view.
- A chord that presses the band's controls from the prompt. Claude Code binds those only on the terminal.
- The caption band of at-o3z.14 is inside the pane, over the code. This change's band is Claude Code's band above the prompt; the two do not meet.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `claude-code-replay`: adds requirements for the band above the prompt and when it shows, the line it and the status entry share, the band's controls, its hotkeys, the status entry, and keeping the status entry off a session that draws on the terminal. No existing requirement's text changes.

## Impact

- `claude-code/hooks/replay.ts`: a pure function from the deck to the shared line (file name, number, state, queued count) and whether anything is typing or queued.
- `claude-code/hooks/register.tsx`: a `band` atom written in `flush` beside `view` and `listing`; a `ui.render` hook on `AbovePrompt` that draws the band from it when the pane is not placed; `$.ui.status` kept in step with the line; hooks on `ui.close`, `ui.open`, `session.attach` and `session.detach` that redraw the band and refresh which surfaces are attached.
- `claude-code/types/index.d.ts`: the `Band` type and the `band` key in `PluginState`. `saved`, `view` and `listing` keep their shapes, so this does not collide with at-o3z.14 and at-o3z.16 moving `view` to `view-2`.
- `claude-code/tests/` and `test/claudeCodeReplay.test.ts`: tests for the line, the band's visibility and controls, the hotkeys, and the status entry.
- `claude-code/README.md`: the band and the status entry.
- No shared module (`core.mjs`) changes.
