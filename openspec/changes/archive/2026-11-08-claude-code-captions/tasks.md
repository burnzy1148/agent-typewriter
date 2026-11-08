# Tasks

## 1. The narration tracker

- [x] 1.1 In `claude-code/hooks/replay.ts`, add a pure narration tracker: per loop key, it takes a row's door and blocks and answers `tool_use_id → caption` for `Edit` and `Write` blocks, per design.md *The narration tracker*, with a `forget(loop)` for a loop's `turn.complete`. Add `normalizeCaption()` (whitespace runs to one space, trim, control characters visible, cut to 1,000 code units with an ellipsis). Unit-test in `test/claudeCodeReplay.test.ts` every scenario of *Each change keeps the agent's words before its call*, two loops interleaved, one response kept as one row and as a row per block, and normalizing. Verify with `npm test`.

## 2. Captions on changes

- [x] 2.1 In `replay.ts`, add optional `caption` to `Change` and carry it through `changeOf()`; add a setter for a kept change's caption by id; add `View.caption` (the shown change's) and `Row.caption` (cut to 300 code units) in `viewOf()` and `listingOf()`. In `claude-code/types/index.d.ts`, add both fields with their meaning and the `<change id>:caption` text member. Unit-test that the caption survives enqueue, playback, seek and `restore`, and shows in `viewOf` and `listingOf`. Verify with `npm test`.
- [x] 2.2 In `claude-code/hooks/register.tsx`, add an observe-only `session.append` hook that awaits `next(e)`, returns its result, and feeds the stored row to the tracker inside a try; skip it in a terminal-only session. Keep answers in a 200-entry `captions` map; `record()` takes a waiting caption when it builds the change, and an answer for an already kept change sets its caption and syncs. Write and blank the `:caption` member with the change's other members, track ids with any member (too-large changes included), and read it on load. Move `view` to `view-2` and `listing` to `listing-3`. Add plugin tests in a new `claude-code/tests/captions.test.tsx`: a main conversation caption, two subagents' captions kept apart, a caption arriving after its change, no caption for a call with no text, the conversation's rows unchanged, a throwing tracker still recording the change, a reload keeping the caption, and `saved-4` state with no caption members loading. Verify with `npm run check:claude-code`. *Superseded in implementation:* the hook is not skipped in a terminal-only session, `listing` moves to `listing-4`, and a test that rows of other blocks and doors leave the recording alone stands in for the throwing tracker, whose guard stays untested; see design.md, *Corrected in implementation*.

## 3. Drawing

- [x] 3.1 In `replay.ts`, add `captionLines(text, columns, maxLines)`: word-wrapped lines, the last cut with an ellipsis when the text does not fit. Unit-test short, exact-fit, long, and a word longer than the width. Verify with `npm test`.
- [x] 3.2 In `register.tsx`, draw the band between the header and the code while `view.caption` is set: muted background, italic, in curly quotes, at most three lines; subtract its height from the code's rows and from `live.list.firstRow`. Add plugin tests: the band while typing, paused, cued and done; none for a change with no caption and before any change; three lines and an ellipsis for a long caption; above the too-large note; the list's wheel still scrolling the right rows with a band. Verify with `npm run check:claude-code`.
- [x] 3.3 In `register.tsx`, give each row with a caption an absolutely placed hover card, hidden until the row is hovered, below the row in the window's top half and above it in the bottom half, at most six lines. Add plugin tests: the card present and hidden at rest on rows with captions, absent on rows without, placed by half, and pressing the row still seeking. Verify with `npm run check:claude-code`. *Superseded in implementation:* the card always opens above the row, with no more lines than the rows above it leave, and the tests check it placed above the row and cut to fit; see design.md, *Corrected in implementation*.

## 4. Docs and integration

- [x] 4.1 In `claude-code/README.md`, describe the caption over the code and the hover card. Verify by reading the section.
- [x] 4.2 Run `npm run typecheck`, `npm test`, `npm run typecheck:claude-code`, `npm run check:claude-code`, and `openspec validate claude-code-captions --strict`. All pass.

## 5. Review fixes

- [x] 5.1 *Added in implementation:* measure `captionLines` in terminal cells, a wide character taking two, and draw each band line as its own `Text` cut at the edge. Unit-test Japanese, Korean, fullwidth and emoji captions, and add a plugin test that a wide-character band takes the rows it counted. Verify with `npm test` and `npm run check:claude-code`.

## Workflow follow-up

- Add the caption band and the hover card to at-o3z.28's desktop check.
- Open a PR into `claude-code-extension`, turn on Auto-fix, and run the review cycle.
- Archive the change on the PR branch once its tasks are done and CI is green.
- Do not merge; the maintainer merges. Close at-o3z.14 after the merge.
