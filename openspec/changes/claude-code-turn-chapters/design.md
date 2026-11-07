# Design

## Context

See proposal.md for why. What exists after at-o3z.12 (archived as `2026-11-06-claude-code-turn-links`):

- Each `Change` carries optional `turnId`, `agentId`, `mainTurnId` and `agentCallId` (`CallLinks`). `mainTurnId` is the main conversation's turn the change belongs to, resolved through the agent chain at `agent.spawn`; `agentCallId` is the `Agent` or `Workflow` call at the top of the chain. Both survive a reload in `saved-4`.
- `register.tsx` hooks `turn.start` and `turn.complete` only to track each loop's running turn id in module memory. It keeps no prompt text and no turn numbers.
- `listingOf(deck)` in `replay.ts` builds the `listing` atom (`listing-2`): flat `Row`s oldest first, `dropped`, `current`, `isPaused`. `Row` has no links.
- The pane draws the list as a window of rows: `listWindow(count, current, height, top)` picks the first row, `firstRow` records the body row the list starts on, and `scrolledTop` maps a pane scroll onto the list.
- A `ui.render` hook on `ToolUse` wraps the engine's row of an `Edit` or `Write` call whose change is kept, adding one chip keyed `chip:<id>` under it, on every surface but the terminal.

What the engine offers, from the plugin API types (`claude-code/.claude-plugin/types/claude-code/index.d.ts`):

- `turn.start` carries `text`: on the main loop, "the user's text as the turn proceeds with it", `""` for a turn started without a typed prompt. Observe-only.
- `turn.complete` carries `turnId` and `agentId` and fires for every loop.
- `ui.render` components and where they are raised: `UserMessage`, `AssistantMessage`, `ToolUse`, `ToolResult`, `ToolGroup` on every surface; **`TurnDuration` (the turn's end row, "Worked for 52 s") on the terminal surface only**. A message row's `requestId` is the message id, and nothing in the API maps a message id to a `turnId` (`$.session.messages()` rows carry no ids).

## Goals / Non-Goals

**Goals:**
- Group the list by turn without changing recording, the saved changes, or playback.
- Keep the grouping a pure function of the listing and the turns, so at-o3z.27's By file grouping is a second function beside it and a switch picks between them.

**Non-Goals:**
- The By turn / By file switch itself (at-o3z.27). The Changes line keeps its title and hint; the switch goes between them later.
- Sticky chapter headers: when the window starts in the middle of a chapter, its header scrolls away like a row.
- Lane tags, colors or an agent's description on rows (at-o3z.15); subagent rows are not indented or tagged here.
- Collapsing chapters.

## Decisions

### A chapter per main turn, not per run

Rows are grouped by `mainTurnId`. A chapter holds every kept change of its turn in recorded order, and chapters are ordered by their earliest kept change. A background agent started in turn 1 that edits during turn 2 adds rows to turn 1's chapter, above turn 2's.

Alternative: chapters as runs of consecutive rows with the same turn, so the list stays in strict recorded order. Rejected: one background agent would split its turn into several chapters with the same number, which the mockup's "subagent changes sit in the turn that called the agent" rules out. The cost is that playback can move from a row in turn 2's chapter back up to turn 1's; the list keeps the current row in view either way.

Rows with no `mainTurnId` share one `Outside a turn` chapter, placed like any other by its earliest row. A `mainTurnId` with no `TurnInfo` (changes recorded by at-o3z.12's plugin before this one) gets an `Earlier turn` chapter per id.

### Turn numbers and prompts: a `turns` atom

`turn.start` on the main loop (no `agentId`) records `{ turnId, number, prompt }` with `number` the next in the session, counting every main-loop turn the plugin sees start. `prompt` is `text` with whitespace runs collapsed to one space, trimmed, and cut to 200 characters; the pane cuts it again to fit. The same hook marks the previous main turn ended, so a turn whose `turn.complete` the plugin missed across a reload still ends. `turn.complete` on the main loop marks its turn `isEnded`.

They are saved in a new atom `turns` (shape `turns-1`): `{ next: number; turns: TurnInfo[] }`, `TurnInfo = { turnId; number; prompt; isEnded? }`. On each write it keeps the running turn and the turns some kept change names as its `mainTurnId`, so it is bounded by the kept changes (at most 201) plus one.

Writes use the queue pattern at-o3z.12 settled for `agents` after its review round 2: a write waits until the load has read and merged the stored value, takes the value as it is when it runs, and the load saves once after merging anything recorded while it read. A turn that starts during the load gets a number after the stored `next`.

Alternatives:
- Add the turns to `saved` (`saved-5`). Rejected: `saved` is rewritten on every playback state change and holds the texts; turns change twice per turn, and a separate atom leaves the saved changes' shape alone, as `agents` did.
- Take the prompt from the `UserMessage` row or `$.session.messages()`. Rejected: neither carries a turn id, so matching would go by text, which fails on a repeated prompt, a prompt a hook rewrote, and a message delivered into a running turn.
- Number only the turns that made changes. Rejected: `Turn 4` should be the fourth prompt the person sent, so the number helps find it in the conversation.

### Rows carry their links; `listing-3`

`Row` gains `mainTurnId` and `agentCallId` from the change, and the `listing` atom's shape moves to `listing-3`. The pane and the chip hook both group from `listing` plus `turns`, and `listing` changes only on state changes, so neither reads the deck.

### Pure grouping in `replay.ts`

```ts
type Chapter = {
  key: string;                         // the turn id, or '' for Outside a turn
  kind: 'turn' | 'earlier' | 'outside';
  number?: number; prompt?: string; isEnded?: boolean;
  rows: Row[];                         // recorded order
};
chaptersOf(listing: Listing, turns: TurnInfo[]): Chapter[]
headerLabel(ch: Chapter, width: number): { title: string; prompt: string; count: string } // prompt cut with '…'
turnChipAnchor(ch: Chapter): string    // last row's agentCallId ?? id
turnChipLabel(ch: Chapter): string     // 'Play turn · 4 changes'
```

The button reads Play turn for `turn` and `earlier`, Play from first for `outside`; each calls `seek(deck, ch.rows[0].id)`, the same path as pressing the row, then makes the list follow again. at-o3z.27 adds a `fileChaptersOf(listing)` returning the same shape (title, sub, count, play label, rows), so the pane draws whichever the switch picks.

### Drawing chapters in the pane

The list becomes a run of *lines*: an optional dropped note, then for each chapter a header line followed by its rows. The window logic works on lines: `listWindow` takes the line count and the current row's line index, and `scrolledTop` and `ListGeometry` count lines instead of rows. `firstRow` is unchanged, since the header area above the list keeps its height.

A header line is a `Box`: bold `Turn <n>` (or `Earlier turn`, `Outside a turn`), the prompt dim and cut to the width left, the count dim, and a plain `Button` keyed `play:<key>` at the right. Tab reaches it between the rows' buttons; no hotkey is added, since `r`, `p`, `f`, `l` stay the transport's.

### The Play turn chip on the turn's last main-conversation row

The `ToolUse` hook, on any surface but the terminal, also looks at `Agent` and `Workflow` rows. For a row whose `tool_use_id` is the anchor of an ended turn's chapter, it adds a plain `Button` keyed `turn-chip:<turnId>` labelled by `turnChipLabel`. On an `Edit` or `Write` row both chips sit in one row `Box` under the engine's drawing. Pressing it does what Play turn does and calls `$.ui.open` for the pane, as the change chip does.

The anchor is the turn's last kept change's own call for a main-loop change, and its `agentCallId` for an agent's, because a subagent's own calls are not rows of the main conversation. The anchor moves when a background agent of an ended turn records another change, which redraws the two rows involved.

**Why not the turn's end row, as the mockup draws it.** `TurnDuration` is raised on the terminal surface only, and the plugin draws nothing there. The at-o3z.12 design named that end row as its fallback; it is not available on desktop or VS Code. The alternatives were a chip on the prompt's `UserMessage` row, rejected because no message id maps to a turn (above), and a single "Play last turn" band, rejected because it covers one turn. A chip on the turn's last row sits where the turn's work ends, which is as close to the end row as the API allows. A bead tracks moving it to the end row if the engine starts raising `TurnDuration` on desktop and VS Code.

Reading `turns` while drawing subscribes `Agent` and `Workflow` rows as well as `Edit` and `Write` rows; `turns` is written twice per turn, so this adds few redraws.

## Risks / Trade-offs

- [The desktop app may draw an `Agent` call as something other than a `ToolUse` row, or not raise it] → that turn's chip just does not show; Play turn in the pane still works. at-o3z.28's desktop check should look at both chips.
- [Turn numbers start at 1 from the first turn the plugin saw, so a plugin installed mid-session numbers from there, and continuation turns started with no prompt take a number] → numbers stay stable within the session, which is what Play turn and the header need. Every main-loop `turn.start` takes a number, so the rule is one place to change if the desktop check shows numbers drifting from the prompts the person sees.
- [Interleaved chapters mean the list's top-to-bottom order is not play order] → the current row stays in view, and Play turn's meaning (play from this turn's first change onward) is the existing seek.
- [Header lines take list height, so fewer rows fit] → one line per turn; the window still centers the current row.

## Migration Plan

`turns` absent loads as `{ next: 1, turns: [] }`; changes recorded under at-o3z.12 keep their `mainTurnId` and show as `Earlier turn` chapters, and changes saved before it as `Outside a turn`. `listing` is derived and rewritten on load under `listing-3`. `saved` keeps `saved-4`. Rolling back ignores the `turns` atom and redraws `listing` under the old tag.

