# Design

## Context

Each recorded change's id is already the `tool_use_id` of the `Edit` or `Write` call that made it (`record()` in `register.tsx`). The deck keeps changes in the shared `Timeline`, whose events carry every field of a change pushed to them; `changeOf()` and `savedOf()` copy fields out by name. The pane draws a header, the code, the controls, a "Changes" line, and a window of the changes list, one plain `Button` per row (at-o3z.3). The `listing` atom holds the rows and the current change's id, and changes only when a change is recorded, starts, finishes or is picked.

What the engine offers, from the plugin API types a session lays in `claude-code/.claude-plugin/types/` (CLI 2.1.309):

- `tool.call` carries `tool_use_id` and `agentId` (the loop's agent, absent on the main loop). It does not carry the turn.
- `turn.start` fires when a turn of any loop begins, before its first model call, with `turnId` and `agentId`. It is observe-only.
- `agent.spawn` carries `parentAgentId` (the loop the spawn happens in) and `tool_use_id` (the `Agent` call, or the `Workflow` call for a workflow's agent); `next(e)` resolves to the started agent's `agentId`.
- `$.ui.scroll({ to: { requestId } })` reveals a render instance, a tool row's being its `tool_use_id`. A transcript row moves only while the call answers the person's own press; otherwise, or when nothing draws that instance, it answers `{ deny }`.
- `ui.render` fires for `ToolUse`, one instance per tool row, `requestId` the `tool_use_id`, with `props.tool` and `props.tool_use_id`. Its doc says `next(e)` "resolves to the drawing: return it, wrap it, draw your own, or rewrite `props`".

## Probe: can a ToolUse hook keep the engine's row and add a chip?

**Yes.** The bead asked for this before building. Two checks:

1. The types say so (above), and `ToolUse` has no tree limit of its own; `AskUserQuestion` is the one component whose doc restricts what a tree around the engine's node may hold.
2. A throwaway plugin test (not committed) hooked `ui.render` for `{ component: 'ToolUse', props: { tool: 'Edit' } }`, awaited `next(e)`, and returned `<Box flexDirection="column">{row}<Button key="chip:…" plain>Replay #2</Button></Box>`. With a stand-in for the engine's row beneath, `$.ui.mount` validated the tree on the desktop, VS Code, mobile and terminal surfaces, found both the engine's node and the Button, and `ui.press` on the chip ran its `onPress`.

What the probe cannot show is how the desktop app lays the wrapped row out; the plugin test kit draws no engine rows. at-o3z.28 already tracks a check of the plugin in the desktop app, and this change adds the chip and Show in conversation to what it should look at.

**Fallback, not built:** if a surface ever refuses the wrapped tree, the engine draws its own row (an invalid tree "draws the engine's"), so nothing breaks; the chip just does not show. The fallback the bead names, one chip on the turn's end row (`TurnDuration`, `Play turn · N changes`), would then go with at-o3z.13's Play turn, which draws a turn's chapter anyway.

## Goals / Non-Goals

**Goals:**
- Record, per change, what at-o3z.13 and at-o3z.14 need, so neither has to change recording.
- Keep the engine's tool rows exactly as drawn, adding only a chip.

**Non-Goals:**
- Turn headers, Play turn, captions, the hover card, lanes (at-o3z.13, .14, .15).
- Reading or storing the turn's prompt text or the agent's description; at-o3z.13 and .15 add those where they draw them.

## Decisions

### What each change records

`Change` (and `SavedChange`) gains four optional fields:

| Field | Value | Who reads it |
|---|---|---|
| `id` (unchanged) | the call's `tool_use_id` | Show in conversation, the chip |
| `turnId` | the turn of the loop that made the call: `turn.start`'s `turnId` for `agentId` | at-o3z.14 matches the call to the `turn.step` text before it in that turn |
| `agentId` | `tool.call`'s `agentId`; absent on the main loop | at-o3z.14, at-o3z.15 (lanes) |
| `mainTurnId` | the main conversation's turn the change belongs to: `turnId` on the main loop; for an agent, the main loop's turn that was running when the top-level agent of its chain was spawned | at-o3z.13 groups rows into one chapter per main turn ("subagent changes sit in the turn that called the agent") |
| `agentCallId` | for an agent's change, the `tool_use_id` of the `Agent` (or `Workflow`) call that spawned the top-level agent of its chain; absent on the main loop | Show in conversation's fallback; at-o3z.13 can draw it as the agent row |

All are optional: a change saved before this version has none, and a call whose turn the plugin did not see start (a plugin reload in the middle of a turn) has no `turnId` until the next `turn.start`.

Alternative: keep only `turnId` and `agentId`, as the bead lists, and let at-o3z.13 resolve agents to main turns. Rejected: the spawn that links an agent to its main turn happens once, before any of its changes, and a later bead cannot recover it for changes already recorded or reloaded.

### Tracking turns and agents

Module memory (not `$.state`) keeps two maps: *Superseded in implementation:* `agents` is also saved in `$.state`; see *Corrected in implementation*.

- `turns`: loop key (`agentId`, or `''` for main) → the running turn's id, set on `turn.start` (the hook calls `next(e)` and returns its result, observing only). `turn.complete` of an agent deletes its key, so the map stays as small as the live loops. *Superseded in implementation:* `turn.complete` of any loop, the main one included, deletes its key; see *Corrected in implementation*.
- `agents`: `agentId` → `{ mainTurnId, agentCallId }`, set on `agent.spawn` once `next(e)` resolves with an `agentId`. With no `parentAgentId` the spawn is the main loop's: `{ mainTurnId: turns.get(''), agentCallId: e.tool_use_id }`. With one, it inherits the parent agent's entry, so a nested agent resolves to the top-level spawn. A resume re-spawns under the same id and overwrites the entry with the resuming turn, which is where its new changes belong.

`record()` reads both when the call starts, beside "before".

A teammate is spawned once and wakes later on messages; its changes keep the turn that spawned it. Workflow agents share their `Workflow` call as `agentCallId`. Both are acceptable for a chapter and a scroll target, and at-o3z.13 can refine grouping without new recording.

### `saved-4`

The four fields are saved with each change and the tag moves to `saved-4`, so a reload keeps them. `savedFrom` reads `saved-3` as stored: its changes simply lack the optional fields. The text members and the `listing`/`view` atoms are unchanged.

Alternative: keep the tag, since every new field is optional. Rejected: the module's rule is to change a tag whenever a value's fields change, so a downgrade starts fresh instead of reading fields it does not know, and the earlier tags are read explicitly.

### Show in conversation

A pure helper, `scrollTargets(change)`, answers `[id]` for a main-loop change and `[id, agentCallId]` for an agent's. The press tries each with `$.ui.scroll({ to: { requestId } })` in order and stops at the first that answers without `deny`. If none does, or the call throws, the pane keeps a one-line note, "That call is no longer in the conversation.", in place of the Changes line's hint; any later press in the pane clears it. *Superseded in implementation:* the note reads "Couldn't scroll the conversation to that call.", and a press that clears it redraws the pane; see *Corrected in implementation*. The press does not move playback or the list.

The header gains the button at its right, so the header stays one row and the list's geometry (`firstRow`) does not change. Each row becomes a `Box` holding the row's `Button` and a plain `Button` `↗` keyed `reveal:<id>`; the row label's width shrinks by the ↗'s columns. A `Button` holds only strings and `Text`, so the ↗ cannot sit inside the row's own `Button`.

No hotkey: `r`, `p`, `f`, `l` stay the transport's, and Tab reaches both buttons.

### The chip

A `ui.render` hook on `ToolUse` passes the event on untouched on the terminal, for any tool but `Edit` and `Write`, and for a call with no row in `listing`. Otherwise it awaits `next(e)` and returns a column `Box` holding the engine's drawing and a plain `Button` keyed `chip:<id>`. Reading `listing` while drawing subscribes the row, so the chip follows playback; `listing` changes only on state changes, not per keystroke, so tool rows redraw rarely.

`chipLabel(row, { isCurrent, isPaused })` in `replay.ts` names the state, from the same rules as `rowLabel`'s state word: Too large for the current too-large change, Typing or Paused for the change being typed, Next for a cued change, Not typed for a too-large change passed, Replay for a played one, Queued otherwise. The number follows, `#<n>`.

Pressing the chip does what pressing the row does (`seek`, and the list follows playback again) and calls `$.ui.open` for the pane; the press is the person's own, so the engine places the pane at any width.

Alternative: a `ui.render` hook on `ToolResult` drawing the chip under the result. Rejected: a standalone row's result is a separate block that the engine may fold, and a group's rows draw results inline; the `ToolUse` row is the one place every call has.

### Testing Show in conversation

The plugin test kit answers a test's own `$.ui.scroll` call through the test's `ui.scroll` hook, but a plugin's `$.ui.scroll` of a transcript row from a press reaches no test hook ("no implementation for ui.scroll"), so the kit cannot stand in for a successful scroll. Plugin tests therefore cover the pane's buttons, that a press changes no playback, and the note when the scroll does not land; `scrollTargets` is unit-tested for the order of targets. The landing itself goes to at-o3z.28's desktop check.

## Risks / Trade-offs

- [A desktop layout of a wrapped tool row that looks wrong, which the test kit cannot show] → the chip is one plain `Button` under the row; at-o3z.28's check covers it, and an invalid tree falls back to the engine's row.
- [`turn.start` missed across a reload mid-turn] → that turn's later changes have no `turnId`; the next turn starts fresh. at-o3z.13 can group such changes with the turn before.
- [Every `Edit`/`Write` row in a long session subscribes to `listing`] → `listing` writes are rare (state changes only), and each redraw is one lookup by id.

## Migration Plan

`saved-3` state loads as it is, without the new fields; nothing else moves. Rolling back to the previous plugin reads `saved-4` as an unknown tag and starts with an empty list for that session, as any earlier downgrade did.

## Corrected in implementation

- *Added in implementation:* **`listing` carries the pause state.** The chip needs to tell Typing from Paused. Reading `view` for that while drawing would subscribe every `Edit` and `Write` row to `view`, which changes on every tick while a change types, and redraw them all twenty times a second. So `Listing` gains `isPaused`, written only when pause toggles, and its tag moves from `listing-1` to `listing-2`. The pane's own status line still reads `view`.
- **The note when a scroll fails.** "That call is no longer in the conversation." claimed the row was gone, but `$.ui.scroll`'s `deny` has several reasons that leave the row in place (`the window moved meanwhile`, `not person-initiated`, `no-surface`), and none that means only "not there". The note now reads "Couldn't scroll the conversation to that call." for every failure, including a change no longer kept. I wrote the first text without reading `UiScrollResult`.
- **The note clears on screen.** `act()` cleared the note in memory and relied on a state write to redraw; a press that moves nothing (Finish current with nothing left) writes nothing, so the note stayed drawn. `act()` now calls `$.ui.invalidate('ui.render')` when it clears a note.
- **The main turn ends with its `turn.complete`.** Only an agent's key was deleted, so a main-loop call between turns (a plugin's own `$.tool.call`) took the finished turn's id, which at-o3z.13 would file under the wrong chapter. Every loop's key is now deleted on its `turn.complete`, so such a change has no turn.
- **Agents survive a reload.** In module memory only, the agent map was lost on a reload, so an agent started before it gave its later changes no `mainTurnId` or `agentCallId`. The map is saved as an `agents` atom (shape `agents-1`): a list of `{ agentId, mainTurnId?, agentCallId? }`, oldest first, the newest 200 kept, written after each spawn through the same write queue as `saved`, and read back on load (spawns seen since the module loaded stay newer). A teammate that outlives 200 later spawns loses its entry; that is the bound's price.
