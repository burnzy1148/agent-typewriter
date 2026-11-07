# Design

## Context

Each change already carries its `tool_use_id` (its id), the turn its call ran in, and its loop's `agentId` (at-o3z.12). The pane draws, top to bottom: a header row, the code (`Code`, or a one-line note), the transport, the "Changes" line, and a window of the changes list, each row a keyed `Box` holding the row's `Button` and a ↗ `Button`. The code's height is what the other parts leave (`rows = bodyRows - 3 - list`), and `live.list.firstRow` records where the list starts so a wheel over it can scroll it. `view` (the shown change, every tick) and `listing` (the rows, on start, finish and pick) are the atoms the pane reads.

What the engine offers for the agent's text, from the plugin API types a session lays in `claude-code/.claude-plugin/types/`:

- **`turn.step`** fires per model request of any loop (`agentId`), and is a *streaming* event: a hook gets `next(e)` as a stream of chunks and must yield every chunk up. `text` chunks carry their block `index`; `tool` chunks carry the block `index`, the call's `id` and `name`. The resolved `TurnStepResult` has `answer` (all visible text, joined) and `toolUses` (name and input, **no id**). The types also say that what leaves the *outermost* hook is what is shown and recorded.
- **`session.append`** fires once per row any conversation of the session keeps, before it is stored, with `door` (`response` for a block of the model's response), `origin` (`{ kind: 'model' }` there), `uuid`, `agentId` (the loop; absent on main) and `message.content`, the row's blocks in order (`text` with `text`, `tool_use` with `id` and `name`). `next(e)` resolves to the row as stored, other hooks' rewrites applied. A hook that relays it unchanged changes nothing.

## Goals / Non-Goals

**Goals:**
- Attribute text to the exact call it precedes, per loop, with no effect on the conversation.
- Draw the caption and the card as the mockup's Main and ChangesList boards do.

**Non-Goals:**
- Markdown in captions, keyboard access to the card (the card is a pointer affordance; the caption over the code is the main surface), captions on the terminal.
- Reading the transcript file or `$.session.messages()`: the rows arrive live.

## Decisions

### Read `session.append` response rows, not `turn.step`

`session.append` is observe-only, carries the loop's `agentId`, and hands the blocks in order with each `tool_use` block's `id`, which is the change's id. The plugin awaits `next(e)` and reads the *stored* row, so the caption is the text the conversation keeps (another plugin's redaction included).

Alternatives:
- `turn.step`'s result: `answer` merges every text block of the response and `toolUses` has no ids, so text cannot be pinned to one of several calls.
- `turn.step`'s chunks: they have the ids, but the hook would sit in the model's stream and must re-yield every chunk of every request in every loop; a fault there breaks the model's response, not just a caption. Its text is what reached this hook, not what was recorded, when a hook above rewrites it. Rejected for blast radius and fidelity.

The hook hears every door, since a row of any door but `response` ends its loop's response run (below). It returns what `next(e)` resolved to, and does its own work after, inside a try so a fault leaves the row as stored. Nothing is done in a session that draws only on the terminal.

### The narration tracker

A pure tracker in `replay.ts`, one entry per loop key (`agentId`, `''` for main): `text` (text blocks seen since the run's last call), `last` (the caption of the run's last call, if the previous block was a call), and `wasCall`. For each block of a response row, in order:

- `text` block, non-blank: if `wasCall`, start a fresh `text`; append the block's text; `wasCall = false`, `last = undefined`.
- `tool_use` block: caption = `text` joined with a space if any, else `last` when `wasCall`, else none. If the block's `name` is `Edit` or `Write` and there is a caption, answer `id → caption`. Then `last = caption`, `text = []`, `wasCall = true`.
- `thinking` and other blocks: skipped.

A row of any other door in that loop (a tool result, a prompt, a delivery, a notice) clears the entry, so text never crosses a response. This implements *Each change keeps the agent's words before its call*; the scenarios there are the tracker's unit tests. A loop's entry is also dropped on its `turn.complete`, so the map holds live loops only.

A response may be kept as one row of many blocks or a row per block; walking blocks in order across rows handles both. If a parallel batch's tool results are kept between its `tool_use` rows, a later call in the batch loses the shared caption; it then has none, which the spec allows ("no such text" is never wrong text).

### Joining a caption to its change

The tracker's answers go into a small map in module memory, `captions: tool_use_id → text`, at most 200 entries, oldest dropped. Two orders are possible, since the engine may start a tool while its response still streams:

- Row first (the usual case): `record()` takes the caption from the map when it builds the change, after the call has run, and deletes the entry.
- Change first: when an answer arrives for an id the deck already keeps, the plugin sets that change's caption and syncs.

An entry for a call that never becomes a change (a failed call, one with nothing to replay) ages out of the map.

Text is normalized once, when kept: whitespace runs to one space, trimmed, control characters made visible with the pane's existing `showControls`, and cut to 1,000 code units with an ellipsis. Display cuts come later.

### Where the caption lives

- In the deck: `Change.caption?: string`, carried through the timeline like the links.
- Across a reload: a third `text` family member, `<change id>:caption`, written when the caption is set, read on load (absent → no caption), and blanked with the change's other members when it goes. Too-large changes keep no before or after members but may have a caption, so the set of ids with members covers captions too. Not in `saved`: 200 captions would bloat an atom rewritten on every start and finish, and the family is how the module already keeps per-change text. `saved` keeps `saved-4`; changes saved before this version simply have no caption member, which is *Captions survive a reload*'s second scenario.
- For drawing: `View.caption` (the shown change's, as kept) and `Row.caption` (cut to 300 code units, enough for the card's lines, so `listing` stays small). The tags move to `view-2` and `listing-3`.

### The band over the code

Between the header row and the code, while `view.caption` is set: a `Box` with a muted background holding one italic `Text`, “caption” in curly quotes. `captionLines(text, columns, 3)` in `replay.ts` wraps at word boundaries to the body's columns and cuts the third line with an ellipsis; the band's height is the lines it returns. The code's rows and `live.list.firstRow` both subtract it, so the list's wheel geometry stays right.

### The hover card

The row's `Box` is already keyed (`row:<id>`), which makes it a hover scope. For a row with a caption it gains a child `Box` drawn `position: "absolute"`, `display: "none"`, `hover: { display: "flex" }`, with a border and background, holding the caption wrapped by `captionLines(row.caption, cardColumns, 6)`. Absolute placement takes no room and moves no row. The card opens below the row in the window's top half and above it (`bottom: 1`) in the bottom half, since the engine clips a placed box to the pane and the list sits at the pane's foot. The pane is not drawn on the terminal, so the card is only ever drawn where there is a pointer; the VS Code surface draws it too.

## Risks / Trade-offs

- [A desktop draws the absolute card differently from the plugin test kit] → at-o3z.28's desktop check adds the band and the card.
- [`session.append` fires for every row of every loop] → the hook does a door check and a few string appends per response row, after `next(e)`; nothing for other doors but clearing one map entry.
- [A response stored as rows interleaved with tool results] → captions degrade to none, never to another call's text.
- [Captions of long messages] → kept at 1,000 code units, shown at three lines over the code and six in the card.

## Migration Plan

None beyond the tags: `view-2` and `listing-3` start fresh on load (both are rebuilt from the deck), `saved-4` and the `text` members stay as they are, and a missing caption member reads as no caption.

## Open Questions

- The exact band and card colors on the desktop: the plugin passes theme-relative colors (`dimColor`, a muted background name); at-o3z.28's check may tune them without changing the spec.
