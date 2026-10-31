# Tasks

## 1. Numbers and tools

- [x] 1.1 In `claude-code/hooks/replay.ts`, add `number: number` and `tool?: 'Edit' | 'Write'` to `Change`; make `enqueue` take a change without its number and stamp it with the deck's `recorded` count; make `changeOf()` read both back. Update `change()` in `test/claudeCodeReplay.test.ts`, and add a unit test that enqueued changes are numbered 1, 2, 3 and keep their tool, and that an unchanged file takes no number. Verify with `npm test`.
- [x] 1.2 In `claude-code/types/index.d.ts`, give `SavedChange` `number` and `tool?`. In `replay.ts`, make `savedOf()` save both, move `SAVED_SHAPE` to `saved-3`, and make `savedFrom()` read `saved-3` as stored and number `saved-2` and `saved-1` changes by place, the last taking `recorded`, with no tool. Unit-test a `saved-3` round trip and both older shapes. Verify with `npm test`.
- [x] 1.3 In `claude-code/hooks/register.tsx`, make `record()` pass the tool that made the change. Verify with `npm run typecheck:claude-code`.

## 2. Seek, From start and Finish current

- [x] 2.1 Give `Shown` the id of the change it shows. Add `seek(deck, id, opts)`: seek the timeline to that change, drop `playing`, clear `hold`, and cue the change (its before text, caret at its first hunk, or the too-large note), leaving `isPaused` alone; do nothing for an id the timeline no longer keeps. Unit-test a seek back and a seek forward while playing (the picked change types next and the rest follow, earlier ones count as played), a seek while paused (nothing types until resume, then the picked change), a seek to the change being typed (it starts over), and a stale `complete` from the overtaken change moving nothing. Verify with `npm test`.
- [x] 2.2 Add `replayFromStart(deck, opts)` as a seek to the first kept change. Unit-test it after everything played and while paused. Verify with `npm test`.
- [x] 2.3 Make `finish()` complete a cued change that is shown and still pending, and show it done; the next change waits. Unit-test Finish current after a seek while paused. Verify with `npm test`.
- [x] 2.4 Make `restore()` cue the next change when the saved state is paused and a change waits, and otherwise show the last played change done as now. Unit-test a seek, `savedOf`, `restore` round trip while paused. Verify with `npm test`.

## 3. Listing

- [x] 3.1 In `claude-code/types/index.d.ts`, add `Row` and `Listing` and a `listing` key in `PluginState`. In `replay.ts`, add `listingOf(deck)`: a row per kept change (the change being typed included when the timeline has dropped it), with its state from the timeline, the lines it adds and removes, `dropped` as the first row's number less one, and `current` as the shown change's id. Unit-test the states of five changes, the counts, `dropped` past the limit, and `current` after a seek while paused. Verify with `npm test`.
- [x] 3.2 Add `listWindow(count, current, height, top?)`: following playback, the current row a third of the way down, clamped; with `top`, `top` clamped. Unit-test following at the start, middle and end, a list that fits, and a scrolled `top` past either end. Verify with `npm test`.
- [x] 3.3 Add a pure helper that lays out a row's label for a width: glyph, `#number`, tool, folder and file name cut at the end to fit, state word, and `+added −removed`. Unit-test the glyphs and words for each state, a too-large row passed and current, a missing tool, and a path cut to fit. Verify with `npm test`.

## 4. Pane

- [x] 4.1 In `register.tsx`, add the `listing` atom (shape `listing-1`) and write it in `flush()` when its JSON changed. Verify with `npm run typecheck:claude-code`.
- [x] 4.2 Redraw the pane as design.md lays it out: header with the current change's number, the code, the controls with From start and hotkeys `r`, `p`, `f`, `l`, the "Changes" line, and the list window, each row a plain `Button` keyed `change:<id>` that seeks to its change. Split the body's rows between the code and the list. Keep drawing nothing on the terminal. Verify with `npm run typecheck:claude-code`.
- [x] 4.3 Keep `listTop` and the last drawn list geometry in module memory; add a `ui.scroll` hook on the pane that moves the list by `e.by` and invalidates when the list does not fit, and passes the event on when it does; reset `listTop` on a row press, From start, Finish current and Skip to latest. Verify with `npm run typecheck:claude-code`.
- [x] 4.4 In `claude-code/tests/pane.test.tsx`, add plugin tests: rows for played, typing and queued changes with their numbers, tools, paths and counts; Paused and Next words; a too-large row that has passed reads Not typed; pressing a row while playing types it next; pressing a row while paused shows it as it was before, marked Next, and resume types it then the rest; pressing the change being typed starts it over; From start after everything played and while paused; Finish current on a picked change; the hotkeys are on the controls; a long list follows playback, stays where a person-shaped `ui.scroll` puts it, and follows again after a row press; dropped changes are counted; a pick while paused survives a reload; `saved-2` state loads with numbers by place and no tool; every surface but the terminal draws the list. Update the reload seeds to `saved-3`. Verify with `npm run check:claude-code`.

## 5. Docs and integration

- [x] 5.1 In `claude-code/README.md`, describe the changes list, picking a change to play from it, From start, and the hotkeys. Check `site/` for pages that describe the plugin's pane and update them to match. Verify by reading the sections.
- [x] 5.2 Run `npm run typecheck`, `npm test`, `npm run typecheck:claude-code`, `npm run check:claude-code`, and `openspec validate claude-code-changes-list --strict`. All pass.
- [x] 5.3 File a bead for grouping the changes list by file (the mockup's By file view), with `--deps discovered-from:at-o3z.3`.

## Workflow follow-up

- Record the change on the bead (`bd update at-o3z.3 --spec-id openspec/changes/claude-code-changes-list`) and remove its `needs-spec` label.
- Open a PR into `claude-code-extension`, turn on Auto-fix, and run the review cycle.
- Check in the desktop app that the wheel scrolls the list and a row press seeks.
- Archive the change on the PR branch once its tasks are done and CI is green, so `openspec/specs/claude-code-replay/spec.md` lands with the code.
- Do not merge; the maintainer merges. Close at-o3z.3 after the merge.
