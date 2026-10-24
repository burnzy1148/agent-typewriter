# Tasks

## 1. Highlight marks (pure)

- [x] 1.1 Add `src/highlights.ts` with `diffMarks(baseline, current)`, returning added ranges and merged removal points from `planHunks`, plus line helpers (lines with added text, whether a line also holds baseline text, the line a removal goes on). Verify with new `test/highlights.test.ts` cases: word change, new lines, created file, deleted file, added-then-removed, removed-then-restored, removal at end of text, and the large-change fallback region
- [x] 1.2 Add `baselineFor(events, cursor, clears, relPath)` (effective clear = max of global and per-file, text at a clear point, earliest-before fallback, trimmed oldest change). Verify with unit cases for each rule in `test/highlights.test.ts`
- [x] 1.3 Add a fuzz test next to the planner's: for random baseline/current pairs, the added ranges lie inside `current`, removal offsets are valid and ascending, and rebuilding the baseline from `current` and the marks reproduces it exactly. Verify `npm test` passes

## 2. Clear points in the timeline and sessions

- [x] 2.1 Add `clearAll`, `clearFile` and `clears` to `Timeline`: record `cursor`, or `playingSeq + 1` mid-change; drop points greater than the new cursor in `seek`/`seekToStart`; keep them through `begin`/`complete`/`seekToEnd`; drop all in `clear()`; map by position in `restore(events, cursor, clears?)`, dropping trimmed ones. Verify with new cases in `test/timeline.test.ts`
- [x] 2.2 Write the optional `highlightsFrom` field in `toSession` and the persistence envelope, read it leniently in `parseSession`, pass it through workspace restore but not Load Session, and update the comment above `SESSION_VERSION`. Verify with `test/session.test.ts` and `test/persistence.test.ts` cases: round trip, a malformed field ignored, a timeline saved without the field, and a loaded session starting with no clears

## 3. Settings and colors

- [x] 3.1 Add `agentTypewriter.highlightAdditions` and `agentTypewriter.markDeletions` (default `true`) to `package.json`, `Settings` in `src/config.ts`, `REPO_SETTING_KINDS` and `schemas/agent-typewriter.schema.json`. Verify the settings sync test and `test/repoSettings.test.ts` pass
- [x] 3.2 Contribute the five colors from the design under `contributes.colors`, and add the light and dark gutter icon SVGs (added bar, removed triangle) under `images/`, included in the packaged `.vsix`. Verify `npm run package` lists the icons and VS Code's color customization picks up the ids
- [x] 3.3 Document highlighting, removal markers, clearing, both settings and the color ids (with a `workbench.colorCustomizations` example) in the README. Verify the README settings table lists every contributed setting

## 4. Rendering

- [x] 4.1 Add `onDidEditMirror` and `liveText(relPath)` to `Player`, fired from `edit()`, and run `flashRange` only when `highlightAdditions` is off. Verify with a typecheck and that existing tests pass
- [x] 4.2 Add `HighlightController` in `src/highlightView.ts`: decoration types from the design, choosing current text (live for the playing file, suppressed when its clear is past the playing seq, `mirrorStates()` otherwise), rendering only when the document text matches, per-file throttle (100 ms with a trailing run), `diffMarks` cache, hover text (20 lines, 500 characters per line, "…N more lines"), re-rendering on visible editors, document, timeline and setting changes. Expose the last rendered marks per mirror URI for tests. Register it in `src/extension.ts`. Verified by the integration section in 6.1 (growing while typing, net diff, clears, replay after a clear, settings off) and the reload check in 6.2; the look is checked in 7.1
- [x] 4.3 Add the deletion preview to `Player`: the red strikethrough on the selected range during the existing pauses, and on the remaining backspace characters at each step, only when `markDeletions` is on and with no added sleeps. Verified by integration checks through `Player.deletionPreview`: a multi-line selection and a backspaced word are previewed, the preview comes down afterward, and nothing is previewed with `markDeletions` off; the look is checked in 7.1

## 5. Clear controls

- [x] 5.1 Register `agentTypewriter.clearHighlights` and `agentTypewriter.clearHighlightsInFile` (`$(clear-all)`), with the latter a no-op unless the active editor is a mirror. Hook buffer clear to clear highlights. Verify with a typecheck and the palette entries
- [x] 5.2 Set the `agentTypewriter.highlightedMirrors` context key (only when it changes) and add the `editor/title` entry at `navigation@6` scoped to the playback mirror with highlights. Verified that the command clears only that file (integration section 6.1); the button's visibility is checked in 7.1
- [x] 5.3 Add `hasHighlights` to `ScrubberState`, a Clear Highlights button to the Playback panel (disabled when false), and `clearHighlights` to the panel's allowed messages. Verify with `test/scrubberState.test.ts` (message parsing) and `test/scrubberWebview.test.ts` (button present, CSP unchanged)

## 6. Integration checks

- [x] 6.1 Add an integration section to `it/suite.ts`. After a change plays: the rendered marks match the expected added lines and removal points, and the mirror text equals the after text. Clear Highlights in This File clears only that file, and a later change is highlighted against the new baseline. Replay Entire Buffer after a clear brings earlier highlights back. A deleted file shows one marker at line 1. With both settings off, nothing is rendered. Verify `npm run it` passes locally and on CI (Ubuntu and Windows)
- [x] 6.2 Extend the restore integration (`it/restore.ts`): clear, play a change, reload, and check the restored mirror's marks show only that change. Verify `npm run it` passes

## 7. Visual check

- [x] 7.1 With `F5`, look at highlights in dark, light and high contrast themes: the colors are subdued, the gutter bar and removal triangle sit where expected, the removal hover shows the removed text, the red strikethrough shows during deletions, and the title bar's Clear Highlights in This File button appears only on the highlighted playback mirror and goes away after clearing

## Workflow follow-up

- Archive on the PR branch once tasks are done and CI is green, then merge.
- Create or claim the bead for this feature and record `--spec-id openspec/changes/highlight-replayed-changes`.
