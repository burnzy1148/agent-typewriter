# Tasks

## 1. Transcript index

- [x] 1.1 `src/transcripts.ts`: `projectsDir`, `encodeProjectPath`, `candidateDirs` (root, ancestors, prefix). Verify: unit tests for POSIX and Windows paths, ancestor and inside-root folders, and an unrelated folder left out.
- [x] 1.2 `TranscriptIndex` line parsing: prompts (system reminders stripped, 1000 chars), narration, edit and `Bash` tool calls with start and end, skipped non-message lines, bad JSON skipped. Verify: unit tests on fixture lines in the shapes in design.md.
- [x] 1.3 Incremental reads (offset plus partial line, appended bytes only, mtime cutoff) and subagent transcripts with `meta.json`. Verify: unit tests that append to a temp transcript between refreshes and check a subagent call gets the parent's turn.

## 2. Matching and correlator

- [x] 2.1 `src/agentContext.ts`: `AgentContext` type and `matchChange` with the edit and command rules. Verify: unit tests for each spec scenario: edit, two edits, rename, later user edit, command, two sessions, parallel commands, the 10-minute running cap.
- [x] 2.2 `ChangeEvent.agent`, `Timeline.annotate`, and `toSession` dropping `agent`. Verify: timeline unit tests. Annotate emits once and keeps text and order. A saved session has no `agent`.
- [x] 2.3 `Correlator`: debounce, 2 s retries for 30 s, settled keys, one try for restored changes, claimed set from annotated changes, on/off. Verify: unit tests with a fake clock and a temp projects folder, including a transcript line written after the change.

## 3. Wiring and UI

- [x] 3.1 `agentTypewriter.agentContext` in `package.json`, `config.ts`, `repoSettings.ts` and the repository settings schema, with the tooltip and setting described on the site's Panels page. Verify: typecheck, and `test/repoSettings.test.ts` (package.json, schema and repo kinds list the same keys).
- [ ] 3.2 Wire the correlator in `extension.ts` (lane roots plus workspace folders, the output channel, settings changes). Verify: `npm run it` passes.
- [x] 3.3 Changes view tooltip shows the prompt, tool and narration. Verify: the tooltip case in `test/agentContext.test.ts`.
- [ ] 3.4 Full check: `npm run typecheck`, `npm test`, `npm run it`. Then a check against real data: a file written by this Claude Code session's `Write` call, matched by its mtime against the session's own transcript, gets that call and turn.

## Workflow follow-up

- Archive this change on the PR branch once CI is green and review is done.
