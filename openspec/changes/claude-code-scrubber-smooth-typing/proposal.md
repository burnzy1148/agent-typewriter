# Proposal

## Why

In the Claude Code pane the only way to move through playback is to press a change in the list, a chip in the conversation, or a chapter's Play turn. There is no way to sweep through the session the way the VS Code extension's Playback panel slider allows. Typing and scrolling also move in steps: the pane redraws from the plugin's 50 ms timer. Each redraw shows every character typed since the last one together, and the code window re-centres on the caret line by line, so a jump to an edit 300 lines down lands in one frame.

The at-o3z.8 mockup answers both on the desktop: a drag scrubber over the followed lane's changes, with a gap between turns, and typing and scrolling eased locally. Both need a `Client` surface module, a region the plugin draws on the drawing thread with its own frame clock, pointer and keys. Claude Code carries `Client` on the terminal and desktop surfaces only. The plugin draws nothing on the terminal, and VS Code and the mobile app have no `Client`. So this is desktop only, and the other surfaces keep the timer-driven pane, with Previous and Next in place of the scrubber.

## What Changes

- **A scrubber on the desktop.** Under the transport row the pane draws one row: the followed lane's name while several lanes are kept, a track with one mark per change of the followed lane in recorded order, and the shown change's position (`4 of 9`). Each mark shows its change's state: played, typing or paused, cued next, queued, too large. The shown change's mark is taller. A one-cell gap separates the changes of one turn from the next. When the lane has more changes than the track has cells, neighbouring changes share a cell.
- **Dragging seeks on release.** Pressing on the track and dragging names the change under the pointer (`#7 signup.ts`) without moving playback. Releasing plays from that change, exactly as pressing its row in the list does, so pause state is kept and the list follows playback again. A click is a drag that does not move. Releasing more than two rows above or below the track cancels. Resting the pointer on the track names the change under it too.
- **Keys on the scrubber.** While the scrubber holds the keyboard after a click, Left and Right play from the change before or after the shown one, and `r`, `p`, `f` and `l` press the pane's controls as they do anywhere in the pane.
- **Smooth typing on the desktop.** The code is drawn by a second surface module. When the plugin's tick types several characters, the module shows them one after another over its own frames, at most one tick behind playback. Anything other than plain typing (a deletion, a change shown at once, a seek, Finish current) is drawn at once. Every change still ends showing its after text exactly.
- **A code window that holds still and scrolls smoothly on the desktop.** The code keeps its rows where they are while the caret stays two or more rows inside the window, instead of re-centring on every keystroke. When the caret leaves, the window eases to put the caret's line in the middle, in whole rows, with the extension's scroll curve and speed (`src/scroll.ts`), divided by the playback speed. A change to another file is drawn at once. The window the module settles on is posted back to the plugin, so the read pause (at-o3z.6) judges what the person actually sees.
- **Previous and Next where there is no scrubber.** On VS Code and mobile, and on the desktop when a surface module fails, the transport adds Previous and Next. They play from the change before or after the shown one in the followed lane, as pressing that row does.
- **A fallback that needs nothing.** If a surface module does not load or fails on the desktop, the plugin stops drawing that module for the session and draws today's timer-driven code view, or Previous and Next for the scrubber.

Out of scope, and kept possible:
- The terminal, where the plugin still draws nothing.
- Sub-row scrolling. A `Client` region is a grid of cells and `Code` has no scroll offset, so the window eases in whole rows.
- Driving playback from the surface module's clock. Playback stays in the hooks module (timeline, steps, persistence, chips, band), which runs whether the pane is open or not. The module only presents it.
- Remote and mobile `Client` support, which waits for clients to attach (at-o3z.24, at-o3z.31).
- Hotkeys for Previous and Next on surfaces without the scrubber.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `claude-code-replay`: adds requirements for the desktop scrubber (marks and their states, turn gaps, fitting the track, dragging, release, cancel, keys), smooth typing, the code window that holds still and eases, Previous and Next where there is no scrubber, and the fallback when a surface module fails. No existing requirement's text changes. Releasing the scrubber, Left and Right, Previous and Next are each defined as pressing a change's row, so *The list keeps up with playback*, *Play from a picked change* and at-o3z.15's *Following a lane moves playback* cover them unchanged.

## Impact

- New `claude-code/hooks/surface.ts`: pure logic shared by both surface modules and the hooks module. Scrubber layout and hit-testing, the reveal plan for smooth typing, framing a view at a given top row, and the hold-still rule.
- New surface modules `claude-code/hooks/scrubber.tsx` and `claude-code/hooks/codeView.tsx`.
- `claude-code/hooks/replay.ts`: the deck records what a tick inserted at the caret (`typed`, with a write sequence) for the view. Previous and Next are expressed as seeks. The read pause's `inView` uses the window the code module posted.
- `claude-code/hooks/register.tsx`: on the desktop, the pane draws `<Client>`s for the code and the scrubber, with props from the `view` and `listing` atoms. A `ui.message` hook validates posts (seek, key, window). A `ui.fault` hook records a failed module for the session and redraws. Elsewhere, Previous and Next go on the transport.
- `claude-code/types/index.d.ts`: `View` gains `seq` and `typed` (a new `view` tag, after at-o3z.15's and .16's).
- `src/scroll.ts` (`scrollSteps`, `centeredTop`) and `scrollLinesPerSecond` from `src/playbackSettings.ts` join the `core.mjs` bundle entry. Both are pure.
- `scripts/build-claude-code.mjs`: only if Claude Code does not resolve a surface module's imports. In that case it also bundles each surface module, with what it imports, into a committed self-contained file that CI checks, as it does for `core.mjs`.
- `claude-code/tests/`: `claude plugin test` cases that mount the pane on `desktop` and `vscode`, drive the modules' pointer, keys and frame clock, and fake a fault. Also `test/claudeCodeSurface.test.ts` for `surface.ts`.
- `claude-code/README.md`: the scrubber, smooth typing, and Previous and Next.
