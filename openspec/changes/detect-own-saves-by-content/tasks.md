# Tasks

## 1. Decision logic

- [x] 1.1 Add vscode-free `src/ownSave.ts` with `decideOwnSave` and verify unit tests in `test/ownSave.test.ts` cover no save (external), matching text (own), differing text (after-own with the saved text as before), and CRLF vs LF input that is equal once normalized

## 2. Recorder

- [x] 2.1 Replace the timestamp map in `recorder.ts` with saved-text entries set on will-save and updated and settled on did-save, and remove `OWN_SAVE_WINDOW_MS`; verify `npm run typecheck` passes
- [x] 2.2 In `flush`, wait up to 1 s for an unsettled entry, apply `decideOwnSave`, consume the entry, and record `after-own` changes with the saved text as before; verify the existing `ignoreOwnSaves` integration section still passes
- [x] 2.3 Update the `ignoreOwnSaves` description in `package.json` and the README so it says saves are matched by content and outside writes right after a save are still recorded; verify both read the same

## 3. Integration checks

- [x] 3.1 Add an `it/suite.ts` section that edits `src/existing.ts` in an editor, saves it, and within 50 ms writes a different version from outside; assert exactly one change with before = saved text and after = disk text, and that the mirror matches disk; verify the section fails on the pre-change recorder and passes now
- [ ] 3.2 Add an `it/suite.ts` check that a save followed by an outside write 3 s later records the outside write, and verify `npm run it` passes locally and on CI (Ubuntu and Windows)

## Workflow follow-up

- Archive the change on the PR branch once tasks are done and CI is green, then merge.
- Close at-net.2 after the merge.
