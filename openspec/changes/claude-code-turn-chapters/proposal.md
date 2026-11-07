# Proposal

## Why

The Claude Code pane lists every kept change as one flat run of rows (at-o3z.3). In a long session the person cannot see which prompt a change answered, or replay one turn without hunting for its first row. at-o3z.12 made each change keep the main conversation's turn it belongs to; this change uses that to group the list into a chapter per turn, as the at-o3z.8 mockup's Main and ChangesList boards draw it. It is the Claude Code counterpart of the extension's chapters (at-3hc.4), taking each turn from `turn.start` instead of a transcript.

## What Changes

- **A chapter per turn.** The changes list groups its rows by the main conversation's turn that made them. Each chapter opens with a header: `Turn <n>`, the prompt that started the turn on one line and cut to fit, how many of its changes the pane keeps, and a Play turn button. Rows keep their numbers, states and buttons, and stay in recorded order within a chapter. Chapters are ordered by their first kept change.
- **Subagent changes sit in the turn that called the agent.** A change a subagent made, however deeply nested, goes in the chapter of the main conversation's turn whose `Agent` (or `Workflow`) call started the top of its chain, even when it was recorded after a later turn began.
- **Play turn.** Pressing Play turn plays from the turn's first kept change, exactly as pressing that change's row does: later changes follow in recorded order and whether playback is paused does not change.
- **Changes with no known turn.** Changes saved before turns were kept, or made outside any turn, form a chapter of their own with no number or prompt.
- **A Play turn chip in the conversation.** Once a turn has ended, the conversation shows a `Play turn · <n> changes` chip on the last row in the main conversation that belongs to the turn's changes: the last such `Edit` or `Write` call, or the `Agent` call that started a subagent whose changes come last. Pressing it plays the turn and opens the pane. The mockup draws the chip on the turn's end row ("Worked for 52 s"), but the engine raises that row (`TurnDuration`) on the terminal only, where the plugin draws nothing; design.md records the check and the choice.
- **Turns survive a reload.** The plugin keeps each turn's number and prompt for the turns that still have kept changes, and their numbers do not change for the rest of the session.

Out of scope, and kept possible:
- The By file grouping and the By turn / By file switch (at-o3z.27). The list's grouping is built so a second grouping drops in beside it; this change draws no switch.
- Lane tags on rows, lane colors and following a lane (at-o3z.15), and captions (at-o3z.14).
- The terminal, where the plugin draws nothing.
- The VS Code extension's chapters (at-3hc.4).

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `claude-code-replay`: adds requirements for chapters by turn, chapter headers, subagent changes in their calling turn, the chapter for changes with no turn, Play turn, the Play turn chip in the conversation, and turns surviving a reload. Modifies *Pane lists the session's changes* (rows are grouped into chapters instead of one oldest-first run), *The list keeps up with playback* (Play turn and its chip join the presses that bring a scrolled list back), and *The list says how many changes were dropped* (its note stays first, above every chapter).

## Impact

- `claude-code/hooks/replay.ts`: a pure grouping of `Listing` rows into chapters, the anchor row for a turn's chip, header and chip labels, and the list window counting header lines.
- `claude-code/hooks/register.tsx`: `turn.start` and `turn.complete` keep the main loop's turn number, prompt and whether it ended in a saved `turns` atom; the pane draws chapter headers with Play turn; the `ToolUse` render hook adds the Play turn chip, now also on `Agent` and `Workflow` rows.
- `claude-code/types/index.d.ts`: `Row` gains `mainTurnId` and `agentCallId`, `Listing`'s tag moves to `listing-3`, and a new `TurnInfo` shape for the `turns` atom.
- `claude-code/tests/` and `test/claudeCodeReplay.test.ts`: tests for grouping, headers, Play turn, the chip, and reloads.
- `claude-code/README.md`: chapters and Play turn.
- No shared module (`core.mjs`) changes; `saved` keeps its `saved-4` shape.
