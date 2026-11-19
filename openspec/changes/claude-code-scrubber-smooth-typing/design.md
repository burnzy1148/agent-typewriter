# Design

## Context

See proposal.md for why. What this builds on, as it will stand when this change is implemented (last in the at-o3z plugin queue):

- **Playback lives in the hooks module.** `register.tsx` ticks the deck every 50 ms (`$.clock.every(TICK_MS)`). After at-o3z.6, each tick pulls steps from `typingSteps` and applies them, with waits in tick time and the read pause in wall time. After at-o3z.17, a chosen speed multiplies on top of catch-up. `flush` writes the `view`, `listing` and other atoms, and the pane's `ui.render` hook draws from them. `frame(view, rows, columns)` cuts the view (up to `VIEW_LINES` = 120 lines around the caret) to the code rows and re-centres on the caret line every draw.
- **Lanes (at-o3z.15).** The timeline follows one lane. Pressing a row follows its lane and seeks there. *Following a lane moves playback*. The `listing` rows carry their lane, and the listing names the followed lane.
- **Turns (at-o3z.13).** Each row has a chapter key: its main conversation turn, or the turn whose `Agent` call started its chain, or "outside a turn".
- **The `Client` element** (engine types, Claude Code 2.1.326):
  - On the `terminal` and `desktop` tables only. `vscode` and `mobile` omit it, and an omitted element draws as a fragment.
  - The module draws with `ClientElements`: the terminal table less `Client`, `Raster`, `Image` and `Progress`. That leaves `Box`, `Text`, `Button`, `Input`, `Select`, `Link`, `Code` and `Markdown`, laid out in cells. It gets `surface.columns` and `rows`, `state` and `setState`, `every(ms, fn)` on the surface's frame clock, `onPointer`, `onKey` (after a click gives it focus; Escape returns focus and never arrives), and `post(data)`.
  - A post reaches the plugin's `ui.message` hook, at most one per frame, and the hook may answer `{ props }`. New props from a redraw reach the running instance with its state kept, as long as its `key` stays in the tree.
  - Pointer events are in cells. After a `down` the instance holds the pointer until `up`, and moves past the edges still arrive. `fine` (sub-cell) is documented only for terminals that report pixels.
  - Each call has a one-second limit. A `setState` on three renders in a row with nothing in between counts as a render loop and unmounts the instance. Trees keep the 20,000-node bound, and props and posts are bounded at 100,000 characters.
  - A failure fires `ui.fault`, and the engine redraws the site. The plugin falls back by leaving the `Client` out.
- **Code has no scroll offset**, and a `Client` region is a cell grid, so any easing is in whole rows.
- **The extension already has the curve.** `src/scroll.ts` gives `centeredTop` and `scrollSteps(from, to, height, linesPerSecond, speed)`: top lines per 60 Hz frame, eased in and out, capped at 1 s, jumping first when more than two viewports away. It is pure. `scrollLinesPerSecond` (default 60) is in `PLAYBACK_NUMBERS`.

## Goals / Non-Goals

**Goals:**
- A drag scrubber and smooth typing and scrolling on the desktop, as the at-o3z.8 mockup draws them.
- Playback state has one owner, the hooks module, so the list, chips, band, persistence and lanes stay as they are. The pane may be closed while playback runs.
- Every surface without `Client` draws exactly as before, plus Previous and Next.
- A module failure costs the person only the smoothness, never the pane.
- An ADDED-only delta, so it archives in any order after the changes it builds on.

**Non-Goals:**
- The terminal.
- Sub-row scrolling, or easing the caret's movement within a row.
- Running the typing steps in the surface module.
- Remote `Client`s (at-o3z.24, at-o3z.31).

## Decisions

### The surface modules present playback; the hooks module still plays it

The hooks module keeps ticking, applying steps and writing `view`. The code module draws the latest `view` it was handed, eased.

*Alternative:* hand the module the change and its steps and let it type on its own clock, posting progress back. Rejected for four reasons:
- The module unmounts when the pane closes, and the band, chips and status entry need playback to go on.
- A change's text can reach 1,000,000 bytes, against a 100,000-character props bound.
- Two clocks would each think they own the caret, and pause, Finish current and seeks would have to cross the boundary both ways.
- *Recording and playback stay decoupled through the Timeline* is easier to keep with one player.

### Smooth typing spreads a tick's insertion over frames

The deck already knows what each tick did. The view gets two fields:
- `seq`: increments on every view write.
- `typed`: the text that write's tick inserted at the caret, when the tick's only edits were insert steps contiguous at the caret. Otherwise it is absent.

The code module keeps the last view it drew. On new props:
- **Animate** when `props.seq === last.seq + 1`, the change id is the same, and `typed` is set. The module draws the new view with the last `k` characters of `typed` held back: removed from before the caret, with the caret drawn where it then stands. Then it lowers `k` on a 16 ms `every` until all of it shows. `typed` may hold newlines (indent inserts), so holding back works on the window's text by offset, not per line. The reveal is spread over the time between the last two props arrivals, clamped to 16–100 ms, with `TICK_MS` before two have arrived.
- **Snap** in every other case: a skipped `seq` (the engine coalesced redraws), a deletion, a selection or `mark` change, a change shown at once, a seek, Finish current, a new change. The module draws the props as they are.
- **Never more than one tick behind.** New props always first drop whatever was still held back.

The last frame of every reveal is the props as handed, so the text shown at the end of a change is the view the hooks module wrote, which is the after text. A paused deck writes no new view, so a reveal finishes and holds.

At 1× (1000 characters a minute, about one character a tick) this changes little. At 4× with catch-up it turns bursts of a dozen characters at 20 Hz into a steady run at the frame rate, which is where the stepping shows.

The frame clock is driven only by `every` ticks. The module calls `setState` from the tick, never from its render, so the render-loop rule never trips. The tick is stopped when nothing is held back or scrolling, and started again when props arrive.

### The code window holds still, then eases

The module frames the view itself, so its rows are known locally:
- **Hold.** While the caret's row is at least `MARGIN = 2` rows inside the window (top and bottom), the top row stays put. Arrow walks, typing and short moves don't scroll.
- **Leave.** When the caret goes past the margin, or off the window, the target top is `centeredTop(caretLine, rows, …)`. The module walks `scrollSteps(currentTop, target, rows, scrollLinesPerSecond, speed)`, one entry per frame, passing `speed` down in props. This is the extension's own curve and cap, so a distant edit scrolls the way it does in VS Code.
- **Lines not held.** The view holds `VIEW_LINES` around the caret. Frames whose top would need lines the view doesn't hold start at the nearest top that fits, as `scrollSteps` already jumps for long moves. A scroll of up to about half the view animates all the way. A longer one jumps to within reach and eases the rest.
- **Other cases.** A change to another file, a change shown at once, and a seek frame at once with the caret centred. A resize keeps the top row and clamps it. Columns shift as `frame()` shifts them today: the caret past the right edge moves the window a third of its width.
- **Posting back.** Once a scroll settles, and on a resize, the module posts `{ kind: 'window', path, firstLine, rows }`. The hooks module stores it on the deck as the drawn window. at-o3z.6's `host.inView(first, last)` then answers from that window instead of re-deriving the re-centred frame, so *Read pause before leaving typed text* ("outside the code rows the pane last drew") holds literally for the window the person sees. Until a post arrives, and on the timer-driven pane, `inView` keeps at-o3z.6's rule. This settles the arrow-walk risk at-o3z.6's design leaves open.

`frame()` stays for the timer-driven pane. The hold, shift and caret-mark logic moves to `surface.ts` as `frameAt(view, top, rows, columns)`, and `frame()` becomes `frameAt` with the re-centred top. Both panes then mark the caret and cut columns the same way.

*Alternative:* keep re-centring on every keystroke and only ease each step. Rejected: one-line eases on every newline read as constant drift, and the extension holds still.

### The scrubber is one row of cells

Layout (`layoutScrubber(ticks, columns)` in `surface.ts`):
- **Label.** At the left, the followed lane's label, cut to 12 columns, while several lanes are kept (at-o3z.15's `lanesInBuffer() > 1`). Otherwise there is none.
- **Readout.** At the right, a readout: `4 of 9`. While dragging or hovering it reads `#7 signup.ts`, plus `· release to play` while dragging, or `release to cancel` past the cancel band. The readout takes the room it needs, cut from the left.
- **Track.** What is left. Each change gets an equal share of the track's cells after the turn gaps. A one-cell gap separates consecutive changes whose chapter keys differ, while gaps take at most a quarter of the track. Past that, no gaps are drawn, since there are too many turns to space. Changes outside a known turn count as one turn.
- **Crowding.** When changes outnumber the cells, each cell stands for a run of neighbouring changes. It draws the state of the shown change if that is in the run, else the most advanced state in it, and hit-testing picks within the run by `fine.x` where given, else the run's first change.
- **Marks.** A mark is `▂` for a change and `▆` for the shown change, coloured by state: played muted, typing and paused clay, cued next blue, queued dim, too large amber. These are the mockup's colours, as CSS colours, which the desktop draws. Played and queued also differ in glyph lightness (queued draws `▁`), so state never rests on hue alone.

Pointer (`onPointer`):
- **`down`** on the track starts a drag on the change under it, which is drawn as a hollow cursor over its mark.
- **`move`** with the button held moves the cursor. Past the track's ends it clamps to the first or last change.
- **`up`** posts `{ kind: 'seek', id }` unless the pointer is more than two rows above or below the scrubber, which cancels. A click is a down and up on one change.
- **Hover** `move`s (no button) set the readout's name. `leave` clears it.

Nothing moves playback until `up`. Seeking on every move would restart typing dozens of times and churn the list.

Keys (`onKey`, after a click gives focus): `left` and `right` post `{ kind: 'step', by: -1 | 1 }`, and `r`, `p`, `f`, `l` post `{ kind: 'key', key }`. The code module forwards the same four letters, since a click on the code also takes focus. Without that, the pane's hotkeys would stop the moment the person clicked into either region.

The hooks module answers posts in a `ui.message` hook matched on the pane's `requestId`. The `data` is code input, so it is checked:
- A `seek` id must be a kept change in the followed lane.
- `step` takes ±1.
- A `key` must be one of the four.
- A `window` needs a number `firstLine` and `rows` and the shown path.

Anything else is ignored. `seek` runs `move($, live, d => seek(d, id, opts))`, the same call pressing the row makes. `step` runs the Previous/Next seek. `key` runs the matching control's handler.

### Previous and Next

`neighbour(deck, by)` in `replay.ts` finds, in the followed lane's kept changes, the one before (`-1`) or after (`+1`) the shown change, and seeks to it through `move`:
- **Previous at the first change** starts that change over, as pressing its row does.
- **Next at the last change** acts as Finish current, the nearest meaning of "after the last".
- **Nothing kept.** Neither button is drawn.

They sit on the transport after Skip to latest and before at-o3z.17's Speed control, keyed `prev` and `next`. They have no hotkeys, so no new keys are claimed on surfaces where the extension's own keys may matter. They are drawn wherever the scrubber is not. On the desktop with a working scrubber they are left off, because the scrubber and its Left and Right keys do the same.

### Where each part is drawn, and the fallback

`ui.render` on the pane:
- **`terminal`:** unchanged, nothing.
- **`desktop`:** `<Client key="code" module="./codeView.tsx" props={codeProps} flexGrow={1} />` in place of `<Code>`, and `<Client key="scrubber" module="./scrubber.tsx" props={scrubberProps} height={1} />` under the transport. A module named in `live.faulted` is drawn the timer-driven way instead: `<Code>` through `frame()`, or Previous and Next.
- **`vscode`, `mobile` and any other surface:** the timer-driven pane, with Previous and Next.

`ui.fault` adds `e.module` to `live.faulted` (session memory, not saved: a reload tries again) and invalidates `ui.render`. The engine redraws the site anyway. The plugin also writes one line to the debug log, so a broken module is visible to the maintainer without bothering the person.

`codeProps` is the view plus `seq`, `typed`, `speed` and `scrollLinesPerSecond`. `scrubberProps` is the followed lane's rows as `{ id, number, name, state, turn, isCurrent }` (at most 200 entries) plus the lane label and paused state. Both stay well under 100,000 characters: the view is capped at `VIEW_LINES` × `VIEW_COLUMNS` = 48,000 characters before JSON.

### Imports in a surface module are checked first

The docs say a hooks module may import files of its plugin, and a surface module is "read off the hooks module's source" and loaded with "the plugin's path". They don't say whether a surface module's own `import`s are resolved. Task 1.1 settles it with a two-line module that imports `./surface.ts`, run through `claude plugin validate` and a `claude plugin test` mount on `desktop`:
- **Imports work:** `codeView.tsx` and `scrubber.tsx` import `./surface.ts` and `./core.mjs` (`scrollSteps`, `centeredTop`).
- **They don't:** `scripts/build-claude-code.mjs` bundles each module, with what it imports, into `claude-code/hooks/codeView.mjs` and `scrubber.mjs` (committed, CI checks them as it checks `core.mjs`), and the `Client`s name those.

Either way the logic stays in `surface.ts`, unit-tested in `test/`.

### Testing

- **`test/claudeCodeSurface.test.ts`:** `layoutScrubber` (gaps, crowding, the quarter cap, label and readout widths), hit-testing, the reveal plan (newline-bearing inserts, held-back offsets), `frameAt`, and the hold/leave rule against `scrollSteps`.
- **`claude-code/tests/scrubber.test.tsx` and `smooth.test.tsx`:** `$.ui.mount` the pane on `desktop`.
  - Find the `Client`s by key, and drive the scrubber's pointer: down, move, up; up far away; a click; hover.
  - Send keys: Left, Right, `p`.
  - Advance the code module's frame clock to watch a reveal and a scroll.
  - Fake a `ui.fault` to see the fallback.
  - The same bodies on `vscode` assert Previous and Next and no `Client`.

## Risks / Trade-offs

- **[Surface module imports are unresolved]** → Task 1.1 decides before anything else is built. The bundling fallback is the pattern `core.mjs` already uses.
- **[The engine coalesces redraws, skipping `seq`s]** → Those frames snap, which is today's look. Smoothness degrades and correctness doesn't.
- **[Smooth typing lags playback by up to one tick]** → The chips, list and band read the deck, not the module, so they may lead the code by 50 ms. That's below notice, and a new view always flushes what is held back.
- **[A surface reports `desktop` that cannot draw `Client`, or VS Code reports `desktop`]** → at-o3z.26 checks surface reporting. A module that fails to load fires `ui.fault`, and the fallback draws the timer-driven pane.
- **[The posted window races the tick's read-pause decision]** → `inView` uses the last settled window, and a scroll in flight counts as not yet drawn. At worst one edit gets a read pause it would not have had in VS Code.
- **[Long scrolls jump part of the way]** → Same as the extension past two viewports. Raising `VIEW_LINES` for the desktop would trade props size on every tick for a longer ease. Not worth it now.
- **[No `fine` on the desktop]** → Hit-testing works in cells. Crowded tracks pick a run's first change, and the readout says which one before release.
- **[Previous and Next only off the desktop]** → The desktop has the scrubber's Left and Right. The spec pins both.

## Migration Plan

- **View tag.** `View` gains `seq` and `typed`, so the `view` atom takes the tag after at-o3z.15's and at-o3z.16's (implementation picks the next free one). `view` is rewritten on the first flush after load, so an old value is never read back. `saved`, `listing` and the other atoms keep their shapes.
- **Fallback memory.** `live.faulted` is module memory.
- **Rollback.** Reverting the PR, plus the bundle rebuild if task 1.1 took the bundling path.

## Open Questions

- Whether the 16 ms frame tick should slow to 33 ms when the desktop window is in the background. The engine's frame clock may already throttle. Task 4.2's desktop check decides it from what the clock does.
