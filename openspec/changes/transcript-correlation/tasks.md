# Tasks

## 1. Transcript index

- [x] 1.1 `src/transcripts.ts`: `projectsDir`, `encodeProjectPath`, `candidateDirs` (root, ancestors, prefix). Verify: unit tests for POSIX and Windows paths, ancestor and inside-root folders, and an unrelated folder left out.
- [x] 1.2 `TranscriptIndex` line parsing: prompts (system reminders stripped, 1000 chars), narration, edit and `Bash` tool calls with start and end, skipped non-message lines, bad JSON skipped. Verify: unit tests on fixture lines in the shapes in design.md.
- [x] 1.3 Incremental reads (offset plus partial line, appended bytes only, mtime cutoff) and subagent transcripts with `meta.json`. Verify: unit tests that append to a temp transcript between refreshes and check a subagent call gets the parent's turn.

## 2. Matching and correlator

- [x] 2.1 `src/agentContext.ts`: `AgentContext` type and `matchChange` with the edit and command rules. Verify: unit tests for each spec scenario: edit, two edits, rename, later user edit, command, two sessions, parallel commands, the 10-minute running cap.
- [x] 2.2 `ChangeEvent.agent`, `Timeline.annotate`, and `toSession` dropping `agent`. Verify: timeline unit tests. Annotate emits once and keeps text and order. A saved session has no `agent`.
- [x] 2.3 `Correlator`: debounce, 2 s retries for 30 s, settled keys, ~~one try for restored changes~~ (superseded, see 4.2), claimed set from annotated changes, on/off. Verify: unit tests with a fake clock and a temp projects folder, including a transcript line written after the change.

## 3. Wiring and UI

- [x] 3.1 `agentTypewriter.agentContext` in `package.json`, `config.ts`, `repoSettings.ts` and the repository settings schema, with the tooltip and setting described on the site's Panels page. Verify: typecheck, and `test/repoSettings.test.ts` (package.json, schema and repo kinds list the same keys).
- [ ] 3.2 Wire the correlator in `extension.ts` (lane roots plus workspace folders, the output channel, settings changes). Verify: `npm run it` passes.
- [x] 3.3 Changes view tooltip shows the prompt, tool and narration. Verify: the tooltip case in `test/agentContext.test.ts`.
- [ ] 3.4 Full check: `npm run typecheck`, `npm test`, `npm run it`. ~~Then a manual check: a real Claude Code session editing a recorded file shows the context in the tooltip.~~ (superseded by 4.1, see below)

## 4. Corrected in implementation

Task 3.4's manual check was rewritten in place after the code landed (commit dc807a6), without saying so. The new text was a narrower check: a file written by this Claude Code session's `Write` call, matched by its mtime against the session's live transcript, got that call and turn. That check ran and confirmed the timing assumption (tool_use, then the file's mtime, then the tool_result, within about 150 ms). But it never ran the recorder, the wiring in `extension.ts` or the tooltip, so nothing covered them. Review round 1 caught it. The manual check is replaced by an integration test (4.1) that runs that path on every CI run, on Ubuntu and Windows. This was my recommendation, approved with the round-1 review plan.

- [ ] 4.1 Added in implementation: an agent context section at the end of the `edits` part of `it/suite.ts`. `it/runTest.ts` points `CLAUDE_CONFIG_DIR` at a temp folder for every launch, so integration tests never read the real `~/.claude`. The section writes a transcript there, with a Windows drive letter in upper case as Claude Code writes it. It then writes the file the transcript's `Write` call names, waits for the recorded change to get that session, turn, call and narration through the activated extension, and checks the Changes view tooltip. Verify: `IT_GROUP=edits npm run it` locally, and CI on Ubuntu and Windows.
- [x] 4.2 Added in implementation (review round 1). Project folders are picked without regard to case, because VS Code lowercases a Windows drive letter. Transcripts written up to 10 min before a waiting change are read, because a transcript is quiet while its call runs. A subagent's parent transcript is read whenever the subagent's is. `prune` keeps a file with a call still running. Background-task notifications do not start a turn. A change is retried for 30 s from when the correlator first sees it, as the spec says, so restored changes get the same 30 s instead of one try. Verify: the new cases in `test/transcripts.test.ts` and `test/agentContext.test.ts`.

## Workflow follow-up

- Archive this change on the PR branch once CI is green and review is done.
