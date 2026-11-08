# Tasks

## 1. Hook listener

- [x] 1.1 `src/hookListener.ts`: parse a hook body into a `HookEvent` (edit tools only, file resolved against `cwd`, no tool input or response kept). Verify: unit tests for `Edit`, `NotebookEdit`, a subagent call, a relative path, `Bash`, a missing id or file.
- [x] 1.2 The HTTP side: `POST /agent-typewriter/hook` answered `200 {}`; `Origin`, non-JSON content type, over 16 MB and non-object bodies refused. Verify: unit tests against a real listener on `127.0.0.1`.
- [x] 1.3 Hub and followers: the events stream with `x-agent-typewriter: 1`, following on `EADDRINUSE`, taking over when the hub closes, logging once and retrying when another program has the port. Verify: unit tests with two and three listeners on one port, the hub disposed mid-run, and a plain HTTP server holding the port.
- [x] 1.4 `HookLog`: 15-minute, 5000-event bound and `onDidAdd`. Verify: unit test.

## 2. Matching

- [x] 2.1 `AgentContext.turn` optional, `via: 'hook'`; tooltip without a prompt line when there is no turn. Verify: typecheck and a tooltip case.
- [x] 2.2 `matchHook` (window, earliest-after else latest-before, shared `claimed`, rename paths, Windows paths). Verify: unit tests for each `Changes are matched to hook events` scenario.
- [x] 2.3 `TranscriptIndex.refresh(..., files)` and `call(id)`. *Corrected in implementation:* calls are looked up by id among `calls()`, no `call(id)` (design.md C3). Verify: unit test reading a transcript outside any candidate folder, and its subagent folder.
- [x] 2.4 Correlator: hook match first, wait for the transcript call until settle, then event-only context; claim held while waiting; a pass on `onDidAdd`. Verify: unit tests with a fake clock: hook plus transcript, transcript written late, transcript unreadable, hook arriving after the change, hook and transcript naming the same call.

## 3. Wiring and docs

- [x] 3.1 `agentTypewriter.hookPort` in `package.json` (application scope, 0 or 1024–65535), read from user settings only in `config.ts`; not in `repoSettings.ts` or the repository schema. Verify: typecheck, `test/repoSettings.test.ts`, a config unit test that a workspace value is ignored.
- [x] 3.2 `extension.ts`: listener lifecycle on `hookPort` and `agentContext`, the `HookLog` into the correlator, the output channel. Verify: `npm run it` on CI.
- [x] 3.3 *Copy Claude Code Hook Settings* command: sets the default port when 0, copies the hooks JSON, says where to paste it. Verify: unit test of the JSON it builds; integration test that the command sets the port and a posted event reaches a recorded change's context.
- [x] 3.4 Docs: hook setup on the site's Panels page (or a new page), `CHANGELOG.md`. Verify: `npm run build` in `site/`.
- [x] 3.5 Full check: `npm run typecheck`, `npm test`, CI integration tests on Ubuntu and Windows.

## 4. Review round 1 (Added in implementation)

- [x] 4.1 Relative hook paths resolved in `cwd`'s own style (design.md C6). Verify: the relative-path unit test on Windows CI.
- [x] 4.2 Hook event ownership by later writes, and holding a late event for the write lag (design.md C4). Verify: unit tests for a user save then an agent edit (the edit reaching the timeline after the event), and a late event with no later write matching after the lag.
- [x] 4.3 Only transcripts of events on waiting changes' files are read (design.md C5). Verify: unit test that an unrelated event's transcript is not passed to `refresh`.
- [x] 4.4 `hookPort` as an integer, `0` or 1024 to 65535, with a one-time log for an ignored value (design.md C7). Verify: typecheck, `npm test`.
- [x] 4.5 `repo-settings` and `agent-context` reload deltas (design.md C8). Verify: `openspec validate --all --strict`.

## Workflow follow-up

- Archive this change on the PR branch once CI is green and review is done.
