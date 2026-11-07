# Proposal

## Why

When Claude starts subagents, their edits interleave with the main conversation's and with each other's, and the Claude Code pane types them all as one stream in recorded order. A person watching cannot tell whose edit is typing, and cannot stay with one agent's work while the others keep going. The VS Code extension solves the same problem for parallel checkouts with lanes (`checkout-lanes`); the at-o3z.8 mockup carries lanes into the pane, with one lane per agent loop instead of per checkout. at-o3z.12 already keeps each change's agent, and at-o3z.5 put the plugin's changes in the shared `Timeline`, which already keeps a cursor per lane, so the pieces are in place.

## What Changes

- **A lane per loop.** The main conversation and each subagent get their own lane, keyed by the `agentId` its loop's `tool.call` carries (none for the main conversation). An agent started by a subagent gets a lane of its own. Every lane keeps its own playback position; all lanes share one buffer and its limits.
- **Labels and colors.** The main conversation's lane is labeled `Main`. A subagent's lane is labeled with the `Agent` call's description, and the pane's header adds its agent type (`subagentType`), both taken from `agent.spawn`. Each lane gets one of five colors, the main conversation's first, and keeps it for the session.
- **Only the followed lane types.** Exactly one lane is followed. The others keep recording and queue. The main conversation's lane is followed by default.
- **Lane chips over the code.** While more than one lane holds changes, a row of chips sits over the code, one per lane: its color, its label, and what it is doing (typing, paused, how many queued, or caught up). The followed lane's chip is marked. Pressing a chip follows that lane.
- **Auto-follow.** On by default, with a toggle at the end of the chip row. Once the followed lane is caught up and quiet for 3 seconds, the pane follows the lane whose oldest queued change was recorded first, as the extension's `autoFollow` does. With it off, a finished agent's played-out lane still gives way to a running lane with changes queued, as a stopped checkout's lane does in the extension.
- **The pane says where playback is.** While there are several lanes, the header names the followed lane, the status counts the changes queued in it and in the other lanes, and each row of a subagent's change names its lane.
- **Controls that move playback work per lane.** Pressing a change follows its lane and replays that lane from it, leaving the other lanes where they are. Play turn and From start move every lane they cover back to its first change there. Skip to latest catches up every lane.
- **Lanes survive a reload**, with their labels, colors, positions, the followed lane and the auto-follow switch. Changes saved by an earlier version load into lanes by the agent they already keep.
- **A single lane looks as before**: no chips, no lane names on rows or in the header.

Out of scope:
- Parallel sessions and their worktrees as lanes. A plugin sees only its own session's calls (the mockup's *One session per plugin* gap).
- A cap on lanes. Recording never refuses a change, so every agent gets a lane; past five lanes the colors repeat.
- A lane chip on the conversation's `Agent` row; theme or user overrides of lane colors; a plugin option for auto-follow.
- The VS Code extension's lanes, which stay as `checkout-lanes` specifies.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `claude-code-replay`: adds requirements for lanes per loop, lane labels and colors, the followed lane, a finished lane giving way, following by hand, auto-follow, the lane chips, the header and rows naming lanes, a single lane looking as before, and lanes surviving a reload, including changes saved without lanes. Modifies *Changes play in recorded order* (within the followed lane), *Pane shows playback status* (queued counts per lane), *Playback controls* (Skip to latest catches up every lane), *Play from a picked change* (follows the change's lane), *From start* and *Play turn* (move every lane they cover), and *Finish current finishes a picked change* (the next change in its lane follows).

## Impact

- `src/lanes.ts` joins the shared bundle (`claude-code/hooks/core.mjs`, `core.d.mts`) for the color slots and the auto-follow decision; `scripts/build-claude-code.mjs` gains it in the entry. No change to its behavior in the extension.
- `claude-code/hooks/replay.ts`: changes are pushed to the `Timeline` in their agent's lane; lane definitions, colors, following, auto-follow, the give-way of finished lanes, per-lane seeks and skips; `savedOf` and `restore` keep lanes; `viewOf` and `listingOf` carry lane facts.
- `claude-code/hooks/register.tsx`: `agent.spawn` keeps the description and agent type; `turn.start` and `turn.complete` mark agent lanes running or finished; the pane draws the chip row, the auto-follow toggle, the followed lane in the header and lane tags on rows.
- `claude-code/types/index.d.ts`: `Saved` moves to `saved-5` with lanes, per-lane positions, the followed lane and the auto-follow switch; `AgentLink` to `agents-2` with description and type; `View` and `Listing` gain lane fields (new tags).
- Tests in `claude-code/tests/` and `test/claudeCodeReplay.test.ts`; `claude-code/README.md`.
- Lands after at-o3z.14, .27 and .16, whose controls (Play from first, tabs, marks) follow the lane rules here; see design.md.
