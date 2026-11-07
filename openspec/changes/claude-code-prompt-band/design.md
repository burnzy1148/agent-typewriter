# Design

## Context

See proposal.md for why, and the delta spec for the behavior. What exists on `claude-code-extension` after at-o3z.13:

- `register.tsx` keeps the deck in module memory and writes what the pane draws to two atoms in `flush`: `view` (`view-1`: status, queued count, the shown file and a window of its text) and `listing` (`listing-3`: rows with numbers, `current`). Each write is skipped when its JSON did not change.
- The pane is opened with `$.ui.open({ id: PANE })` on the first recorded change (unasked) and by `/typewriter` (asked). Nothing hooks `ui.close`, and the plugin keeps no record of whether the pane is placed.
- The plugin never calls `$.ui.status` and has no `AbovePrompt` hook.
- Controls go through `act` (any press) and `move` (a press that moves playback, which also makes the list follow). The pane's hotkeys are `r`, `p`, `f`, `l`.
- `isTerminalOnly` asks `$.session.surfaces()` on each recording; `ui.render` hooks pass on `e.surface === 'terminal'`.

What the engine offers (plugin API types of this build):

- `ui.render` on `{ component: 'AbovePrompt' }`: one instance, **raised on the terminal and desktop surfaces only**. Props: `hasSurvey` (yield to it), `isWorking`, `maxRows`, `bodyColumns`, `scroll`, `view`. The engine draws its own `[-]` collapse mark and lets the person focus the band (a click, ctrl+x tab); a focused band arms its Buttons' `hotkey`s, which never fire from the composer except a bare digit in an empty one.
- `Button.action` binds an engine keybinding's chord from the prompt, on the terminal only.
- `$.ui.panes()`: this plugin's open panes with `isPlaced`, `isShown`, `isFocused`. The engine's record, so it survives a module reload.
- `ui.close` fires on every close, with `origin.kind` `plugin`, `person` or `unload`. `ui.open` resolves `{ isPlaced }`. `session.attach` and `session.detach` fire as surfaces come and go.
- `$.ui.status(text)`: one status line per plugin under the prompt, `undefined` removes it. It is session-wide: it carries no surface, and no render hook can keep it off one surface.

## Goals / Non-Goals

**Goals:**
- One pure function produces the line the band and the status entry share, so they cannot drift and the wording is unit-tested without the engine.
- Leave `saved`, `view` and `listing` as they are. at-o3z.14 and at-o3z.16 both move `view` to `view-2`; this change stays out of that.
- Ask the engine, not module memory, whether the pane is placed.

**Non-Goals:**
- Any change to the pane itself.
- Lane awareness (at-o3z.15 may scope the queued count and add a lane color to the band).

## Decisions

### A `band` atom written in `flush`

`replay.ts` gains `bandOf(deck, cwd)`, returning `null` before the first recorded change, else `{ line, isActive, isPaused }`: the shared line, whether a change is typed or any waits (`deck.playing !== undefined || deck.timeline.pendingCount() > 0`), and whether Pause should read Resume. `flush` writes it to a new `band` atom (`band-1`) when its JSON changes, as it does `view`, and calls `$.ui.status` in the same step (see below).

Alternative: compute the line in the `AbovePrompt` hook from `view` and `listing`. Rejected: `view` has no change number, so the hook would read two atoms and redraw on every list change, and the status entry, which is set outside any render, would need the same code a second time. Adding the number to `view` would move it to a new shape that collides with .14 and .16.

The line uses the file's last path segment rather than the pane's relative path: the band is one row beside three buttons, and the pane, one press away, names the full path. The queued count is `pendingCount()`, the number the pane's status shows.

### The band asks `$.ui.panes()` when it draws

The `AbovePrompt` hook passes (`next(e)`) on the terminal surface, when `hasSurvey`, when `band` is `null` or not `isActive`, and when `$.ui.panes()` lists the pane with `isPlaced` true. Otherwise it draws a row: the line in a `Text` cut at the end (`wrap="truncate-end"`, growing to fill), then the three Buttons.

Reading the engine's record rather than a flag the module keeps means a reload, a close from the engine's mark, a close by an unload, and an open placed later by a widened window all read right without the module tracking them.

The band redraws when `band` changes, which covers playback moving. A close or open that changes nothing in `band` (the person closes the pane while paused) has no atom write behind it, so the plugin hooks `ui.close` and `ui.open` (observe only: `await next(e)`, then `$.ui.invalidate('ui.render')`), and `session.attach` / `session.detach` the same way.

Alternative: a `paneShown` atom the module sets from those events. Rejected: it duplicates the engine's record and gets it wrong across a reload or an engine-side placement change.

### Controls and hotkeys

Pause is `act($, live, togglePause)`, Skip to latest `move($, live, skipToLatest)`, as the pane's. Going through `move` keeps whatever else the pane does on a move (the list following now, at-o3z.16's pin clearing later). Open pane calls `$.ui.open({ id: PANE, title: TITLE })` from the press, which counts as asked and is placed at any width; when it still answers `isPlaced: false`, the plugin shows `openedText(opened)` with `$.ui.toast`.

Hotkeys `p`, `l`, `o`: the first two match the pane's keys for the same controls, and `o` is free in the pane. Open pane is the `primary` variant, as the mockup draws it dark. The Buttons set no `action`: the engine honors it only on the terminal, where the plugin draws nothing.

Keys: `band:pause`, `band:skip`, `band:open`.

### The status entry follows `band.line`, off while a terminal is attached

`flush` calls `$.ui.status(line)` when the line differs from the one last set, and `$.ui.status(undefined)` when a terminal is attached. Which surfaces are attached is kept in `live.hasTerminal`, set in `session.start` and refreshed in the `session.attach` / `session.detach` hooks, which then set or clear the entry at once. `flush` stays synchronous about surfaces.

The status entry is kept whether or not the pane is open, as the mockup draws it under the prompt in every state, so a person with the pane docked still sees playback's state when the pane scrolls or another pane's tab is in front.

Alternative: keep the status entry in a mixed session, since the requirement "Nothing is drawn on the terminal surface" is about the plugin's drawing. Rejected: the status line is drawn on the terminal like any other, and the plugin cannot keep it off one surface.

### No change to `/typewriter` or the first-change open

The band reuses `openedText`, `PANE` and `TITLE`. The first-change open, its no-surface notice and `/typewriter` answers stay as specified.

## Risks / Trade-offs

- [VS Code gets no band] → Claude Code does not raise `AbovePrompt` there. The status entry carries the state, if VS Code draws plugin status lines; task 3.2 checks and the README says what VS Code shows.
- [The band redraws on every tick while typing] → `band` changes only when the line, `isActive` or `isPaused` changes: once per change, per pause and per queue length change, not per keystroke. `view` already redraws the pane per tick.
- [`$.ui.panes()` is called on every band draw] → it is one engine call answered from memory, and the band draws only when `band` changes or the hooks above invalidate.
- [A pane placed but behind another pane's tab still hides the band] → out of scope (proposal). `isShown` is available if it is wanted later, but no event says when the shown tab changes, so the band could not keep up.
- [`ui.render` invalidation redraws every render hook of the plugin] → the same call the pane's note already uses; the pane and the chips redraw from atoms they already read.

## Migration Plan

`band` is a new atom with its own shape tag, so a reload from a version without it starts from the default (`null`), and the next `flush` fills it. No stored shape changes. Rollback is reverting the change; a stale `band` atom is ignored by a version that does not declare it.
