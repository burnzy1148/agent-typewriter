# Tasks

## 1. Share the lane policy

- [ ] 1.1 Add `src/lanes.ts` (`colorSlot`, `autoFollowDecision`, `autoFollowTarget`, `LANE_COLORS`, `AUTO_FOLLOW_IDLE_MS`, `type LaneActivity`) and `laneOf` with `type SavedLane` / `LaneRestore` from `src/timeline.ts` to `CORE_ENTRY` in `scripts/build-claude-code.mjs`, update its header comment and the *Shared core* paragraph in `CLAUDE.md`, and run `npm run build:claude-code`. Verify the bundle builds for the neutral platform, `core.d.mts` declares the new exports, `test/lanes.test.ts` still passes under `npm test`, and the stale-bundle check passes.

## 2. Lanes in the deck

- [ ] 2.1 In `claude-code/hooks/replay.ts`, push each change with `lane: agentId` and define its lane at its first change (`defineLane` with label, color from `colorSlot` over the buffer's lanes, `recording` true for Main and for an agent whose loop is in a turn). Add `laneLabel(agent)` (description with whitespace collapsed, else type, else `Subagent`; `Main` for `''`) and `setRunning(deck, agentId, running)`. Unit-test in `test/claudeCodeReplay.test.ts`: lanes per loop, a nested agent's own lane, the label fallbacks, colors in order and repeating past five, a lane gone once its changes are dropped, a first change from a subagent followed at once, and only the followed lane typing while others queue. Verify with `npm test`.
- [ ] 2.2 Add `follow(deck, lane, opts)` (overtakes the change being typed, keeps the pause state, shows the lane's last change done when it has nothing queued) and auto-follow: `autoFollow` and `quietSince` on the deck, updated on keystrokes, finished changes and new changes in the followed lane, and `tick(deck, opts, now)` asking `autoFollowDecision` when it types nothing. Unit-test: switch and come back, switch mid-change, follow while paused, the tour of two lanes after 3 s each, a busy followed lane staying followed, no switch mid-change, auto-follow off, a finished lane giving way to a running one with auto-follow off, and Main not giving way. Verify with `npm test`.
- [ ] 2.3 Make the controls per lane: `seek` follows the change's lane and seeks within it; `replayFromStart` rewinds every lane and follows the first kept change's lane; a `playFrom(deck, ids)` for Play turn rewinds each lane to its first id and follows the first id's lane; `skipToLatest` catches up every lane and keeps the followed one; `finish` unchanged. Update `playTurn` in `register.tsx` to use it. Unit-test each modified scenario in the delta (pick in another lane, From start with several lanes, a turn with subagents, Skip to latest with several lanes, finish a picked change's lane). Verify with `npm test`.

## 3. Lanes survive a reload

- [ ] 3.1 In `claude-code/types/index.d.ts`, move `Saved` to `saved-5` (`lanes`, `positions`, `followed`, `autoFollow`; `played` gone) and `AgentLink` to `agents-2` (`description?`, `subagentType?`). In `replay.ts`, write them in `savedOf`, rebuild cursors, lanes, the followed lane and the switch in `restore` (agent lanes finished until their next `turn.start`), and in `savedFrom` derive lanes from `saved-4` and `saved-3` (positions from the played prefix, Main followed when it has a change, auto-follow on). Unit-test a three-lane round trip and the migration scenario in *Changes saved without lanes still load*. Verify with `npm test`.
- [ ] 3.2 In `claude-code/hooks/register.tsx`, keep `description` and `subagentType` from `agent.spawn` in `live.agents` and the `agents` atom (`agents-2`, reading `agents-1`), and call `setRunning` on agent `turn.start` / `turn.complete`. Add plugin tests in a new `claude-code/tests/lanes.test.tsx`: a reload with three lanes keeping labels, colors, positions, the followed lane and auto-follow off; a subagent described before a reload and first editing after it; a reload from `saved-4` with agents. Verify with `npm run check:claude-code`.

## 4. Lanes in the pane

- [ ] 4.1 Extend `View` (followed lane's label, kind, color; other lanes' queued count) and `Listing` (lanes with state and queued count, the followed lane, the switch; each row's lane) under new tags in `types/index.d.ts` and `register.tsx`, with `laneChips(listing, columns)` in `replay.ts` returning the chips that fit in two rows and how many were left out, and `rowLabel` taking a lane tag. Unit-test chip states, the 24-character cut, the left-out order (caught-up unfollowed first, the followed chip never), and row cutting with a tag. Verify with `npm test`.
- [ ] 4.2 In `register.tsx`, draw the chip row (`lane:<id>` Buttons, primary for the followed lane, a colored `●`, label and state; `+N more`; the `auto-follow` Button) only while several lanes hold changes; the followed lane's `●` and label (with type) at the head of the header and `· N in other lanes` in the status; and `● label` on a subagent's rows. Pressing a chip follows the lane through `move` (the list keeps up again); pressing the switch flips auto-follow through `act`. Plugin tests in `lanes.test.tsx`: three lanes' chips and their states, pressing a chip, a scrolled list brought back by a chip, the switch, too many lanes for two rows, the header and rows naming lanes, a single Main lane and a single subagent lane drawing no chips or names, and nothing on the terminal. Verify with `npm run check:claude-code`.

## 5. Docs

- [ ] 5.1 In `claude-code/README.md`, describe lanes: one per subagent, labels and colors, chips, following, auto-follow and its switch, and that other sessions and worktrees are not lanes. Check `site/` pages that describe the plugin's pane and update them. Verify by reading the sections.

## 6. Integration

- [ ] 6.1 After at-o3z.14, .27 and .16 have archived, rebase this branch onto `claude-code-extension`, re-read `openspec/specs/claude-code-replay/spec.md`, and adjust the delta: add a MODIFIED block making a file group's *Play from first* play the rest of its change's lane, and confirm no MODIFIED block here overwrites a requirement those changes modified. Apply the lane rules to their controls in code (Play from first follows the lane; tabs and marks read the followed lane; a chip press ends a pin). Verify with `openspec validate claude-code-subagent-lanes --strict` and plugin tests for Play from first in another lane and a pin ended by a chip.
- [ ] 6.2 Run `npm run typecheck`, `npm test`, `npm run build:claude-code` (no diff), `npm run typecheck:claude-code`, `npm run check:claude-code`, and `openspec validate claude-code-subagent-lanes --strict`. All pass.

## Workflow follow-up

- Add the lane chips, the auto-follow switch and lane tags to at-o3z.28's desktop check.
- Open a PR into `claude-code-extension`, turn on Auto-fix, and run the review cycle.
- Archive the change on the PR branch once its tasks are done and CI is green.
- Do not merge; the maintainer merges. Close at-o3z.15 after the merge.
