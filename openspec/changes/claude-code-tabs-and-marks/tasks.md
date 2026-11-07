# Tasks

## 1. Share the net diff

- [ ] 1.1 Move `netHunks` and the helpers and constants it uses from `src/highlights.ts` to a new `src/netHunks.ts` that imports neither `vscode` nor Node built-ins, and re-export `netHunks` from `highlights.ts`. Verify with `npm test` (the highlight tests pass unchanged) and `npm run typecheck`.
- [ ] 1.2 Add `netHunks` to `CORE_ENTRY` and the header in `scripts/build-claude-code.mjs`, run `npm run build:claude-code`, and add `src/netHunks.ts` to the shared core list in `CLAUDE.md`. Verify the bundle builds and `npm run typecheck:claude-code` passes.

## 2. Diff rows and the view

- [ ] 2.1 In `claude-code/hooks/replay.ts`, add `diffRows(baseline, text)`: whole-line ` `, `+` and `-` rows with old and new line numbers, a hunk's `-` rows before its `+` rows, memoized on its last inputs. Unit-test a function added, a word changed, lines removed, a created file and identical texts. Add a fuzz test that the ` ` and `+` rows give back the text and the ` ` and `-` rows give back the baseline. Verify with `npm test`.
- [ ] 2.2 In `claude-code/types/index.d.ts`, replace `View`'s `lines` and `firstLine` with diff rows. Make `viewOf(deck, baseline)` keep `VIEW_LINES` rows around the caret's row, with long lines cut and control characters shown as now. Make `frame()` cut the rows to the pane, put the caret into its row, and prefix one `@@ -a,b +c,d @@` header counted from the rows it keeps. Update the existing view and frame unit tests, and add ones for a window that starts on a `-` row and on a `+` row. Verify with `npm test`.

## 3. Baselines and clears

- [ ] 3.1 Add a `Clear` type (`{ at: number; heldBack?: string }`) and `baselineOf(deck, path, clears)` per design.md: the before text of the lane's first kept change to the path, reset at each clear that has passed, with a held-back file unmarked while its change is typed. Unit-test the requirement's scenarios: several changes, added then removed, a created file, the oldest change dropped, a clear then more changes, a clear while typing, and a cued change. Verify with `npm test`.
- [ ] 3.2 Add `clearMarks(deck, clears)`, which appends a clear at the current point (at most 50 kept), and make `seek` return the clears with every one past the picked change dropped. Unit-test a seek back past a clear, a seek forward that keeps it, and Skip to latest, which keeps it. Verify with `npm test`.

## 4. Deletion preview

- [ ] 4.1 Give `Playback` a `preview` tick count. In `tick`, start a long deletion with an 8-tick beat that ends the tick, count it down, then delete. Make `viewOf` draw the rows the pending deletion touches as `-` during the beat. Unit-test a deleted function in the baseline (marked during the beat, still marked after), lines typed since the baseline (marked during the beat, gone after), a pause during the beat that holds it, Finish current that skips it, a backspaced deletion with no beat, and the fuzz test of planned text still reproducing the after text. Verify with `npm test`.
- [ ] 4.2 Update "Long deletions are removed at once" in `claude-code/README.md` if it describes timing, and document the beat. Verify the README matches the spec's wording.

## 5. Tabs and the pin

- [ ] 5.1 Add `tabsOf(deck)`: one entry per path with a played change in the lane or the shown change, in order of its first kept change, each naming the change it shows. Add `tabLabels(paths, cwd)` and `tabRows(labels, shown, width)`. Unit-test two files, a waiting change with no tab, a seek back that removes a tab, a clash of base names, and 30 tabs that keep the shown one in two rows and count the rest. Verify with `npm test`.
- [ ] 5.2 Make `viewOf` draw a pinned path: the tab's change's after text, around where its typing ended, with its marks and no caret, or its too-large note. Unit-test it. Verify with `npm test`.

## 6. Pane

- [ ] 6.1 In `claude-code/hooks/register.tsx`, add the `tabs` (`tabs-1`) and `marks` (`marks-1`) atoms, move `view` to `view-2`, and write each in `flush()` when its JSON changed. Load the clears on module load, and make `move()` apply `seek`'s clears. Keep `live.pin`, cleared by `move()`, Follow playback, a press on the playback file's tab, and a sync that no longer lists the path. Verify with `npm run typecheck:claude-code`.
- [ ] 6.2 Draw the tab rows as plain buttons, the shown tab bold and the rest dim, with the left-out count. Draw the Viewing line with Follow playback while pinned, the code with `format: 'diff'`, and Clear marks after Skip to latest. Take the tab rows, the Viewing line and the hunk header out of the code's rows. Verify with `npm run typecheck:claude-code`.
- [ ] 6.3 In `claude-code/tests/pane.test.tsx`, add plugin tests: tabs for played and shown files and none for waiting ones; a pin shows the pinned file, the Viewing line and Follow playback while typing goes on; Follow playback, the playback tab, a row press, a chip press, From start, Finish current and Skip to latest each end the pin, and Pause does not; the code is drawn as a diff with added and removed rows; the beat draws rows removed before a deletion; Clear marks leaves no marks and a later change marks only itself; a seek back past a clear brings the marks back; a clear survives a reload; a pin does not; and the pane's rows still fit the body. Check that a 1 MB file keeps a tick within budget, and if not, apply design.md's mitigation. Verify with `npm run check:claude-code`.
- [ ] 6.4 Document tabs, pinning, the diff marks and Clear marks in `claude-code/README.md`. Verify the README names each control as the pane labels it.

## 7. Integration

- [ ] 7.1 Run `npm test`, `npm run typecheck`, `npm run typecheck:claude-code`, `npm run check:claude-code` and `npm run build:claude-code` with no diff to the committed bundle. Verify all pass.
- [ ] 7.2 Run `openspec validate claude-code-tabs-and-marks --strict` and a trial archive check that the living spec still validates strictly. Verify both pass.

## Workflow follow-up

- Check tabs, the diff view, the beat and Clear marks in the desktop app, including whether the surface draws the hunk header as a row, and file any gap as a bead discovered from at-o3z.16.
- Archive the change on the PR branch once tasks are done and CI is green.
