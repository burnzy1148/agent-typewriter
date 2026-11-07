# Tasks

## 1. Turns and agents on each change

- [x] 1.1 In `claude-code/hooks/replay.ts`, add optional `turnId`, `agentId`, `mainTurnId` and `agentCallId` to `Change`, and copy them in `changeOf()`. In `claude-code/types/index.d.ts`, add them to `SavedChange` with their meaning. Make `savedOf()` save them, move `SAVED_SHAPE` to `saved-4`, and make `savedFrom()` read `saved-3` as stored. Unit-test in `test/claudeCodeReplay.test.ts` that the fields survive enqueue, `savedOf`, `restore`, and a `saved-3` value loads without them. Verify with `npm test`.
- [x] 1.2 In `claude-code/hooks/register.tsx`, track each loop's running turn on `turn.start` (dropping an agent's on `turn.complete`) and each agent's main turn and `Agent` call on `agent.spawn`, a nested agent inheriting its parent's. Make `record()` stamp the four fields. Add plugin tests in `claude-code/tests/recording.test.tsx`: a main-loop change, a subagent's change, a nested agent's change, and a reload keeping the fields. Verify with `npm run check:claude-code`.

## 2. Show in conversation

- [x] 2.1 In `replay.ts`, add `scrollTargets(change)` (the call, then the `Agent` call for an agent's change) and a lookup of a kept change by id. Unit-test both. Verify with `npm test`.
- [x] 2.2 In `register.tsx`, add a Show in conversation button to the header while a change is shown, and a ↗ button keyed `reveal:<id>` beside each list row, narrowing the row label to fit. A press scrolls to the first target that lands and changes no playback; when none lands, the Changes line shows "That call is no longer in the conversation." until the next press in the pane. Add plugin tests in `claude-code/tests/pane.test.tsx`: the header button only while a change is shown, a ↗ per row on every surface but the terminal, a press leaves playback and the list as they were, the note when the scroll does not land and its clearing. Verify with `npm run check:claude-code`.

## 3. The chip

- [x] 3.1 In `replay.ts`, add `chipLabel(row, at)`: Replay, Typing, Paused, Next, Queued, Too large or Not typed, then `#<number>`. Unit-test each state. Verify with `npm test`.
- [x] 3.2 In `register.tsx`, add a `ui.render` hook on `ToolUse` that wraps the engine's row with a chip keyed `chip:<id>` for an `Edit` or `Write` call whose change is kept, and passes the event on untouched otherwise and on the terminal. Pressing the chip seeks to the change, makes the list follow again, and opens the pane. Add plugin tests: the chip's label through played, typing, paused, next, queued and too-large states; the engine's row kept beside it; no chip for a failed call, a dropped change, a `Bash` call, or on the terminal; pressing it opens the pane and plays from the change, and while paused cues it. Verify with `npm run check:claude-code`.

## 4. Docs and integration

- [x] 4.1 In `claude-code/README.md`, describe Show in conversation and the chip. Check `site/` for pages that describe the plugin's pane and update them to match. Verify by reading the sections.
- [x] 4.2 Run `npm run typecheck`, `npm test`, `npm run typecheck:claude-code`, `npm run check:claude-code`, and `openspec validate claude-code-turn-links --strict`. All pass.

## 5. Corrections in implementation

- [x] 5.1 *Added in implementation:* give `Listing` an `isPaused` flag (tag `listing-2`) so the chip reads the pause state without subscribing to `view`; unit-test it in `listingOf`'s tests. Verify with `npm test`.
- [x] 5.2 *Added in implementation:* the plugin tests that 1.2, 2.2 and 3.2 name went into a new `claude-code/tests/links.test.tsx` rather than `recording.test.tsx` and `pane.test.tsx`, which keeps the linking tests together; `seed` moved to `tests/world.ts` so both files share it. Verify with `npm run check:claude-code`.

## 6. Review round 1

- [x] 6.1 *Added in implementation:* make `act()` redraw the pane when it clears the note, and test a no-op Finish current on one live mount. Verify with `npm run check:claude-code`.
- [x] 6.2 *Added in implementation:* delete the main loop's turn on its `turn.complete` too, and test a change made between turns. Verify with `npm run check:claude-code`.
- [x] 6.3 *Added in implementation:* say "Couldn't scroll the conversation to that call." for every failed scroll, and correct the requirement, proposal and design in place. Verify with `npm run check:claude-code` and `openspec validate claude-code-turn-links --strict`.
- [x] 6.4 *Added in implementation:* save the agent map in an `agents` atom (`agents-1`, newest 200) and read it on load; test a reload and the bound. Verify with `npm run check:claude-code`.
- [x] 6.5 *Added in implementation:* name the top of the chain in the fallback requirement, and add the chip to *The list keeps up with playback* under `## MODIFIED`; update the README's note text. Verify with `openspec validate claude-code-turn-links --strict`.

## 7. Review round 2

- [x] 7.1 *Added in implementation:* hold `agents` writes until the load has read and merged the stored list, write the list as it is then, and save after the merge; test a spawn during the load. Verify with `npm run check:claude-code`.

## Workflow follow-up

- Record the change on the bead (`bd update at-o3z.12 --spec-id openspec/changes/claude-code-turn-links`) and remove its `needs-spec` label.
- Add the chip and Show in conversation to at-o3z.28's desktop check.
- Open a PR into `claude-code-extension`, turn on Auto-fix, and run the review cycle.
- Archive the change on the PR branch once its tasks are done and CI is green, so `openspec/specs/claude-code-replay/spec.md` lands with the code.
- Do not merge; the maintainer merges. Close at-o3z.12 after the merge.
