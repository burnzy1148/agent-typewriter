# Design

## Context

`typeHunk` calls `scrollTo` (from `smooth-scroll-to-edits`) and then sets `editor.selection` at the edit. Setting the selection from the API does not scroll the editor, so intermediate caret positions can be shown without moving the view, as long as they are inside it.

## Goals / Non-Goals

**Goals:**
- Nearby, visible edits are reached by a key-by-key caret walk, as specified in `specs/edit-navigation/spec.md`.
- The walk goes through the same `ready()` checks as typing, so pause, seek, skip, closing the tab, and finish current behave the same.

**Non-Goals:**
- Arrow keys that scroll the view (Page Up/Down, walking past the viewport edge). Edits outside the view keep the scroll-then-click.
- Mouse-cursor animation, or selection-extending moves.

## Decisions

### Pure path in `src/caretPath.ts`

`caretPath(lineText, from, to, maxKeys)` returns the caret position after each press, ending at `to`, or `undefined` when it needs more than `maxKeys` presses:
1. Vertical first, one line per press, keeping `from.character` clamped to each line's length (VS Code's sticky column).
2. On the target line: Home or End when the target is column 0 or the line end and more than two presses away. Otherwise word jumps (word-right lands at the end of the next word, word-left at the start of the previous one, using `[\p{L}\p{N}_$]` as word characters) while they don't pass the target, then single characters.
3. No position lands inside a surrogate pair (it reuses `splitsPair` from `typingChunks.ts`).

It takes a `lineText(n)` callback instead of the whole document, so a walk on a big file reads only the lines it crosses.

### `Player.navigate` decides walk or click

`navigate(relPath, editor, offset, smooth, epoch)`:
- Walks only when `smooth` (the same flag that suppresses scrolling after a file switch) is set, `arrowNavigation` is on, finish current isn't pending, and one visible range holds every line from the caret to the target **before** `scrollTo` runs. An edit that needed a scroll is clicked, the way a person who scrolled with the mouse clicks. Requiring a single range keeps the walk out of folded regions, which VS Code would unfold when the caret entered them. The start is `validatePosition(selection.active)`.
- Calls `scrollTo` (a no-op when the target is in view), then for each key: `ready()`, stop on finish current, set the selection, sleep `humanize(1000 / arrowKeysPerSecond) / speedMultiplier`.
- Always ends by setting the caret at the edit's offset, so a walk cut short by finish current still lands right, then reveals it if it is outside the view (setting a selection doesn't scroll, and the user may have scrolled during a pause).

`ARROW_MAX_KEYS = 24` is a constant rather than a setting: about ten lines plus a few words is where a person stops pressing keys and clicks.

### Settings

| Setting | Default | Range |
|---|---|---|
| `arrowNavigation` | `true` | boolean |
| `arrowKeysPerSecond` | 15 | ≥ 1 |

### Integration tests

The general integration workspaces in `it/runTest.ts` set `arrowNavigation: false`. Their timing-sensitive checks (partial inserts, pause and seek windows) were tuned to the caret being placed at once. The PLAY section turns the setting on and covers the walk, pause, finish current, and skip to latest during the walk, and the setting turned off.

## Risks / Trade-offs

- A caret on a much longer line than the target loses its column on short lines in between, the same as in VS Code. The path then mostly walks horizontally on the target line, which is bounded by `maxKeys`.
- At 15 keys per second, a 24-key walk adds up to 1.6 s at 1x. Catch-up speed shortens it when changes queue.
