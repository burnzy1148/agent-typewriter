# Design

## Context

The deck (`claude-code/hooks/replay.ts`) keeps the session's changes in the shared `Timeline` on its default lane: played ones behind the cursor, the one being typed (`deck.playing`, begun with a token), and the waiting ones. `deck.shown` is what the pane draws: the playing change's text, or the last change done. `deck.hold` counts ticks a change shown at once stays before the next starts. A timer calls `tick()` every 50 ms.

`register.tsx` writes two things the pane reads: `saved` (shape `saved-2`: every kept change as `{ id, path, kind, time, isTooLarge? }`, how many lead as played, `recorded`, `isPaused`) and `view` (status, queued count, and a window of the shown text around the caret). `flush()` writes each only when its JSON changed; `view` changes on almost every tick while typing.

The pane is one `Pane` site. Its body is a window of `scroll.bodyRows` rows over the tree the hook draws; a taller tree scrolls as a whole. The engine raises `ui.scroll` before the window moves (the person's wheel or scroll keys, or `$.ui.scroll`), and a hook that answers without calling `next` keeps the window still, which is how a hook scrolls rows it draws itself. A `Button` holds only strings and `Text`, takes a `key` (its address after a redraw), and a one-letter `hotkey` that works while the pane holds the keyboard.

The extension's seek (`src/extension.ts`, `seekTo`) calls `Timeline.seek(seq)`, interrupts the player and keeps the pause state. Its "replay all" seeks to the start and resumes.

The design is the ChangesList and Main boards of the at-o3z.8 mockup.

## Goals / Non-Goals

**Goals:**
- One row per kept change, with a number that never changes in the session.
- A pick is a `Timeline.seek`, so recording and playback stay decoupled and a reload keeps what the pick did.
- The list fits the pane beside the code and keeps up with playback.

**Non-Goals:**
- More than one lane. The plugin still plays the default lane only; lane tags and following another lane are at-o3z.15.
- Turn headers, Show in conversation, captions (at-o3z.12, .13, .14).
- A scrubber or Previous and Next controls (at-o3z.19).
- Keeping where a pick paused mid-change across a reload. As now, a change being typed starts over.

## Decisions

### A pick seeks the timeline and cues the picked change

`seek(deck, id, opts)` finds the kept change by id and calls `Timeline.seek(seq)`. That moves the cursor so the change is next, bumps the timeline's generation (so a stale `complete` from the change being typed changes nothing) and stops counting it as playing. The deck drops `playing`, clears `hold`, and cues the picked change: `shown` becomes its file's before text, the caret where its first hunk starts, or the too-large note. `isPaused` is left alone. If the deck is not paused, the next tick starts the change from that same text; if it is, nothing moves until Resume.

A change that the timeline has dropped since the pane drew its row is no longer kept, so the press does nothing.

Alternative: begin the picked change at once and leave it paused at its first keystroke. Rejected: the timeline would call it playing, so the pane could not tell a pause in the middle of typing (Paused) from a pick waiting to play (Next), and `savedOf` would save it as the change being typed.

### "Next" is the shown change while it is still pending

`deck.shown` carries the id of the change it shows. The pane's current change is that id. Its row reads Next when the timeline still has it pending, Typing or Paused when it is playing, and Too large when it is too large. So Next appears exactly when the pane shows a cued change, and needs no flag of its own. During the hold after a change shown at once, the pane still shows that played change, and the next change stays queued until it starts.

### From start is a pick of the first row

`replayFromStart` seeks to the timeline's first kept change and keeps the pause state, as the mockup's From start does: it sits beside the rows and does what pressing the first row does.

Alternative: resume, as the extension's "replay all" does. Rejected: in the pane, From start then would behave unlike the row it is a shortcut for, and resuming is one more press, or `p`.

### Finish current finishes a cued change too

`finish` completes the change being typed, as now. With none being typed but a cued change shown, it completes that one with `Timeline.complete(seq)` and shows it done; the next change waits and starts on the next unpaused tick. Without this, Finish current would do nothing right after a pick while paused, though the pane shows a current change.

### Each change keeps a number and its tool; `saved-3`

`Change` gains `number` (the deck's `recorded` count once it is enqueued, so 1 for the session's first change) and `tool` (`'Edit' | 'Write'`, from the hook that recorded it; optional, since older saved state lacks it). `enqueue` stamps the number. `SavedChange` gains both, and the tag moves to `saved-3`.

`savedFrom` reads `saved-3` as stored. Under `saved-2` and `saved-1` it numbers the changes by place, the last taking `recorded` and each earlier one the number before, and leaves `tool` out. That is exact unless the timeline had dropped a change being typed with others after it, or a change's texts went missing, both rare; the numbers stay unique and in order either way.

Alternative: derive numbers from `recorded` at every draw, saving nothing. Rejected: a change skipped at reload, or one typed past the limit, would renumber the rows after it, and the tool would still need saving.

### The list is its own `$.state` value

A `listing` atom (shape `listing-1`) holds `{ rows, dropped, current? }`, each row `{ id, number, tool?, path, state, isTooLarge?, added, removed }` with `state` the timeline's `played | playing | pending`. `listingOf(deck)` builds it; `flush()` writes it when its JSON changed, which is only when a change is recorded, starts, finishes, or a pick moves the cursor, not on every keystroke. `dropped` is the first row's number less one: every change recorded before the oldest kept one is gone.

Alternative: put the rows in `view`. Rejected: up to 201 rows would be rewritten on every tick while typing.

### Pane layout: code, controls, then the list

Top to bottom, as on the mockup's Main board: the header (file name, the current change's number, status), the code, the controls (From start, Pause or Resume, Finish current, Skip to latest, with hotkeys `r`, `p`, `f`, `l`), a "Changes" line ("Pick a change to play from it"), and the list. The list gets up to 40% of the body's rows, at least 3, and no more than it needs; the code gets the rest, at least 3. The whole tree fits the body, so the engine has nothing of its own to scroll.

Each row is one plain `Button` keyed `change:<id>`: a glyph (✓ played, ▸ typing, paused or next, ○ queued, ⊘ a too-large change that has played), `#<number>`, the tool, the folder dim and the file name bold, the state word, and `+added −removed`. A pure helper cuts the folder first, then the file name, each at its end, so a row stays one line at the body's width and keeps the file name as long as it can. A later bead can add a lane dot, a reveal `Button` beside the row, or a turn header above a group of rows without changing this.

### The list scrolls itself

`listWindow(count, current, height, top?)` picks the first row to show. Following playback, it puts the current row a third of the way down, clamped to the list. With `top` set it clamps that instead. The module keeps `listTop` (undefined while following) and the geometry the pane last drew. A `ui.scroll` hook on the pane moves `listTop` by `e.by` when the list has more rows than fit, asks for a redraw with `$.ui.invalidate('ui.render')`, and answers `{}` so the engine leaves the body still; when the list fits it passes the event on. A row press, From start, Finish current and Skip to latest set `listTop` back to undefined.

Every scroll on the pane moves the list, wherever the pointer is: the code view follows the caret and cannot be scrolled, so the list is the only thing to move.

Alternative: draw every row and let the engine scroll the body. Rejected: a long list would push the code out of view, and keeping the current row in view would mean scrolling the code away.

## Risks / Trade-offs

- **The test kit raises `ui.scroll` only as a test constructs it.** → Tests raise a person-shaped event (`by`, `bodyRows`, `contentRows`, origin `person`) on the pane, which the kit hands to the plugin's hook; a manual check in the desktop app confirms the wheel scrolls the list.
- **Keyboard users reach only the rows drawn.** Tab walks the drawn rows; one scrolled out of the window is not drawn. → The window follows playback, From start reaches the first change, and the wheel or scroll keys move the window.
- **A desktop draws proportional text.** A row cut to the body's cells can still wrap or leave room. → Rows are cut with a margin, and the tree's height does not depend on it, since each row is one `Button`.
- **A rollback to an earlier version drops `saved-3` state.** → As with every tag bump, the earlier version starts the session's pane fresh.

## Migration Plan

Ship in one change: `saved-3` is written from the first flush after a reload, and `saved-2` or `saved-1` state from before the update loads through `savedFrom`. Nothing else is stored.
