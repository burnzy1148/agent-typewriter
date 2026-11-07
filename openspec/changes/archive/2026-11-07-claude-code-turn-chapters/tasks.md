# Tasks

## 1. Chapters as data

- [x] 1.1 In `claude-code/types/index.d.ts`, add `mainTurnId` and `agentCallId` to `Row`, and the `TurnInfo` type and the `turns` atom's value `{ next; turns }` to `PluginState`. In `claude-code/hooks/replay.ts`, make `listingOf` copy the links onto rows, and move the `listing` atom's shape in `register.tsx` to `listing-3`. Unit-test in `test/claudeCodeReplay.test.ts` that rows carry both links and lack them for a change without. Verify with `npm test`.
- [x] 1.2 In `replay.ts`, add `chaptersOf(listing, turns)` (group by `mainTurnId`, recorded order within, chapters by earliest row, `turn` / `earlier` / `outside` kinds), `headerLabel(chapter, width)` (prompt on one line, cut with `…`, `1 change` / `<n> changes`), `turnChipAnchor(chapter)` and `turnChipLabel(chapter)`. Unit-test two turns, interleaved turns, a nested agent's change in its calling turn, `Earlier turn`, `Outside a turn`, a dropped first change, a long multi-line prompt, an empty prompt, and the anchor for a main-loop and an agent's last change. Verify with `npm test`.

## 2. Keeping turns

- [x] 2.1 In `register.tsx`, on a main-loop `turn.start` record `{ turnId, number, prompt }` (whitespace collapsed, cut to 200 characters) and mark the previous main turn ended; on a main-loop `turn.complete` mark its turn ended. Save them in a `turns` atom (`turns-1`) written through a queue that waits for the load's merge, as `agents` is, keeping only the running turn and turns a kept change names. Add plugin tests in `claude-code/tests/chapters.test.tsx`: numbering across turns with and without changes, an agent's turn not numbered, a reload keeping numbers and prompts and numbering on, a turn starting during the load, a turn running at a reload ending at the next `turn.start`, and pruning once a turn's changes are dropped. Verify with `npm run check:claude-code`. *Superseded in implementation:* the atom also keeps the turns a known agent names; see task 6.1 and design.md, *Corrected in implementation*.

## 3. Chapters in the pane

- [x] 3.1 In `replay.ts`, make the list window count lines (dropped note, chapter headers, rows) instead of rows: `listWindow` takes the current row's line index, and `ListGeometry` and `scrolledTop` count lines. Update their unit tests. Verify with `npm test`.
- [x] 3.2 In `register.tsx`, draw each chapter's header line (title, cut prompt, count, a plain `Button` keyed `play:<key>` reading Play turn or Play from first) above its rows. Pressing it seeks to the chapter's first row and makes the list follow again. Add plugin tests in `chapters.test.tsx`: headers for two turns, a subagent's change under its calling turn, `Earlier turn` and `Outside a turn` after a reload from older state, Play turn while playing and while paused, a scrolled list brought back by Play turn, the dropped note above the first chapter, and no list before the first change. Verify with `npm run check:claude-code`.

## 4. The Play turn chip

- [x] 4.1 In `register.tsx`, extend the `ToolUse` render hook to `Agent` and `Workflow` rows and add a `Button` keyed `turn-chip:<turnId>` on the anchor row of each ended turn, beside the change chip on an `Edit` or `Write` row. Pressing it plays the turn, makes the list follow, and opens the pane. Add plugin tests: the chip on the last change's row of an ended turn, on the `Agent` row when a subagent's change is last, none while the turn runs, the anchor moving when a background agent records later, the engine's row kept, pressing it with the pane closed, and none on the terminal. Verify with `npm run check:claude-code`.

## 5. Docs and integration

- [x] 5.1 In `claude-code/README.md`, describe chapters, Play turn and the Play turn chip, including that the chip sits on the turn's last row because the end row is not drawn outside the terminal. Check `site/` for pages describing the plugin's pane and update them to match. Verify by reading the sections.
- [x] 5.2 Run `npm run typecheck`, `npm test`, `npm run typecheck:claude-code`, `npm run check:claude-code`, and `openspec validate claude-code-turn-chapters --strict`. All pass.

## 6. Review round 1

- [x] 6.1 *Added in implementation:* keep the turns a known agent names as well, and test a background agent started in a turn with no changes of its own that records after the next turn starts; add the scenario and widen *Turns survive a reload*. Verify with `npm run check:claude-code` and `openspec validate claude-code-turn-chapters --strict`.
- [x] 6.2 *Added in implementation:* keep a prompt over 200 characters as its first 199 and `…`, name the cap in *A chapter's header* with a scenario, and unit-test it at 240 and 300 columns. Verify with `npm test`.
- [x] 6.3 *Added in implementation:* show a prompt's control characters as visible stand-ins when it is kept and when it is drawn; unit-test it and add a plugin test that the pane still draws. Verify with `npm test` and `npm run check:claude-code`.
- [x] 6.4 *Added in implementation:* say in `claude-code/README.md` that every main conversation turn takes a number, and that only turns with changes get a chapter. Verify by reading the section.

## Workflow follow-up

- Add both chips (change and Play turn, on `Edit`/`Write` and on `Agent` rows) and the chapter headers to at-o3z.28's desktop check.
- Open a PR into `claude-code-extension`, turn on Auto-fix, and run the review cycle.
- Archive the change on the PR branch once its tasks are done and CI is green, so `openspec/specs/claude-code-replay/spec.md` lands with the code.
- Do not merge; the maintainer merges. Close at-o3z.13 after the merge.
