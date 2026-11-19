# Proposal

## Why

The Claude Code pane types every change at the one speed the `charsPerMinute` option sets. The person can't slow down a change they want to read, or speed through a run they only want to skim, without changing a plugin option. And when the agent gets ahead, the queue grows with nothing to say playback is falling behind. The VS Code extension has both a playback speed and catch-up. The at-o3z.8 mockup carries them into the pane's transport: a speed control from 0.5× to 4× and a catching-up chip. at-o3z.17 builds the local part, on the desktop and VS Code surfaces.

## What Changes

- **A speed control on the transport.** After Skip to latest, the pane draws a Speed control with four choices: 0.5×, 1×, 2× and 4×, 1× until the person picks another. The chosen speed multiplies the typing speed and shortens every wait playback makes, the pause between changes included, by the same factor. A pick applies from the next keystroke and does not change whether playback is paused.
- **The chosen speed survives a reload** of the plugin within the session.
- **On top of catch-up.** at-o3z.6 (`claude-code-shared-typing-steps`) brings the extension's catch-up speedup into the plugin, with the manual factor fixed at 1. This change makes the chosen speed that manual factor; it does not define catch-up again.
- **A catching-up chip.** While a change is typed, playback is not paused, and the followed lane has three or more changes queued, the transport ends with a chip reading `catching up <n>×`, `<n>` being the catch-up speedup in effect.
- **Hotkeys.** `r`, `p`, `f` and `l` already press From start, Pause or Resume, Finish current and Skip to latest (requirement *Playback hotkeys*). This change keeps them and adds none.

Out of scope, and kept possible:
- The remote part, moved to at-o3z.31 (which waits on at-o3z.24): four Buttons in place of the Select on mobile, and writing the view 10 times a second with two ticks' worth of typing per frame on surfaces that redraw at most 10 times a second. Here, a surface that carries no Select draws no speed control; the chosen speed still applies.
- A hotkey for the speed, and speeds other than the four.
- Keeping the chosen speed across sessions, and a plugin option for its default.
- Per-language speeds (`languageSpeeds`).

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `claude-code-replay`: adds requirements for the speed control, what the speed applies to, keeping it over a reload, the catching-up chip, and leaving the control off a surface without a Select. No existing requirement's text changes. Catch-up itself is at-o3z.6's *Catch-up speed* requirement, which the chip refers to.

## Impact

- No shared module changes: the catch-up function is at-o3z.6's `catchUpSpeed` in `src/typingSteps.ts`.
- `claude-code/hooks/replay.ts`: the four speeds, a speed check, the chip label, and the chosen speed passed as at-o3z.6's manual factor, which multiplies the typing rate and divides every wait.
- `claude-code/hooks/register.tsx`: a `pace` atom (`pace-1`: the chosen speed, the catch-up factor and whether the chip shows) written in `flush` and read back on load; the Speed Select and the chip on the transport row. `saved`, `view` and `listing` keep their shapes, so this does not collide with at-o3z.15 and at-o3z.16 bumping them.
- `claude-code/types/index.d.ts`: the `Pace` type and the `pace` key in `PluginState`.
- `claude-code/tests/` and `test/claudeCodeReplay.test.ts`: tests for the speed, the reload, catch-up and the chip.
- `claude-code/README.md`: the speed control and the chip.
