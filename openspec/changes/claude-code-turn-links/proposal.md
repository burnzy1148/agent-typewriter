# Proposal

## Why

The Claude Code pane lists the session's changes (at-o3z.3), but nothing ties a change to the conversation that made it. The person cannot jump from a row to the `Edit` or `Write` call behind it, or from a call in the conversation to its replay. at-o3z.12 links the two both ways, as the at-o3z.8 mockup's Main and ChangesList boards draw it. Chapters by turn (at-o3z.13) and narration captions (at-o3z.14) also need each change to know its turn and its agent, so this change records them.

## What Changes

- **Each change knows where it came from.** When it records a change, the plugin keeps the tool call's id (already the change's id), the turn the call ran in, and the agent whose loop made it (none for the main conversation). For a subagent's change it also keeps the main conversation's turn that started the agent and the `Agent` call that started it. All of these survive a reload. The saved state's tag moves from `saved-3` to `saved-4`, and state saved under `saved-3` loads with these fields absent.
- **Show in conversation.** The pane's header gets a Show in conversation button while it shows a change, and each row of the changes list gets a ↗ button beside it. Either scrolls the conversation to the `Edit` or `Write` call that made the change. When that call's row is not in the conversation, as for a subagent's call, it scrolls to the `Agent` call that started the agent instead. When neither is there, the changes list says the call is no longer in the conversation.
- **A chip on the call's row.** In the conversation, the row of each `Edit` or `Write` call whose change the pane keeps gets a chip that names the change's state and number: Replay #2, Typing #2, Paused #2, Next #2, Queued #2, Too large #2 or Not typed #2. Pressing it plays from that change, as pressing its row in the list does, and opens the pane. The engine's own row stays as it is; the chip draws below it.
- The probe the bead asks for found that a `ToolUse` render hook can keep the engine's row and add a chip, so the fallback (a chip on the turn's end row only) is not built. design.md records the probe.

Out of scope, and kept possible:
- Chapters by turn and Play turn (at-o3z.13), captions and the hover card (at-o3z.14), lane tags and following another lane (at-o3z.15). They read the fields this change records.
- The terminal, where the plugin still draws nothing: no chip on its tool rows.
- The VS Code extension's counterpart (at-3hc.2).

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `claude-code-replay`: adds requirements for keeping each change's turn and agent across a reload, loading `saved-3` state, Show in conversation from the header and from each row, and the chip on a call's row in the conversation. No existing requirement's text changes.

## Impact

- `claude-code/hooks/replay.ts`: `Change` gains `turnId`, `agentId`, `mainTurnId` and `agentCallId`; `savedOf` saves them; `SAVED_SHAPE` moves to `saved-4` and `savedFrom` reads `saved-3`; new helpers for a chip's label and a change's scroll targets.
- `claude-code/hooks/register.tsx`: `turn.start` and `agent.spawn` hooks track the running turn of each loop and where each agent was started; `record()` stamps the fields; the pane draws Show in conversation and a ↗ per row; a `ui.render` hook on `ToolUse` adds the chip.
- `claude-code/types/index.d.ts`: `SavedChange` gains the four optional fields. *Added in implementation:* `Listing` gains `isPaused` and its tag moves to `listing-2` (design.md, *Corrected in implementation*).
- `claude-code/tests/` and `test/claudeCodeReplay.test.ts`: tests for the fields, the reload, the buttons, and the chip on every surface but the terminal.
- `claude-code/README.md`: Show in conversation and the chip.
- No shared module (`core.mjs`) changes.
