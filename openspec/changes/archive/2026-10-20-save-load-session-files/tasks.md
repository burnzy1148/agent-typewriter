# Tasks

## 1. File encoding

- [x] 1.1 Add `sessionToBytes` and `sessionFromBytes` to `src/persistence.ts`, use them in `TimelineStore`, and verify `test/persistence.test.ts` covers plain and gzip round trips, a gzip file from workspace storage loading as a session file, and non-session JSON being refused with `SessionFormatError`

## 2. Commands

- [x] 2.1 Add `agentTypewriter.saveSession` and `agentTypewriter.loadSession` to `package.json` (Command Palette and the panel's `...` menu) and `src/extension.ts`: dialogs defaulting to the home folder, empty-buffer message, confirm before replacing, `historyLimit` choice, paused start at the first change, URI argument skipping the dialogs; verify `npm run typecheck` and `npm test` pass
- [x] 2.2 Document session files in the README (commands, file format, default location, and that saving into the workspace records the file); verify the README matches the command titles in `package.json`

## 3. Integration checks

- [x] 3.1 In `it/restore.ts`, save the session to a file outside the workspace through the command with a URI, assert the file parses and the workspace git status is unchanged, clear the buffer, load the file, assert the same changes all pending and playback paused, resume, and assert every replayed file's mirror ends at its last recorded after text; also load a non-session file and assert the buffer is unchanged; verify `npm run it` passes locally and on CI (Ubuntu and Windows)

## Workflow follow-up

- Rebase onto `main` once at-dqb.1 (PR burnzy1148/agent-typewriter#5) is merged, and open the PR to `main`.
- Archive on the PR branch once tasks are done and CI is green, then merge.
- Close at-dqb.2 after the merge.
