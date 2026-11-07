# Tasks

## 1. Hook listener

- [x] 1.1 `src/hookListener.ts`: parse a hook body into a `HookEvent` (edit tools only, file resolved against `cwd`, no tool input or response kept). Verify: unit tests for `Edit`, `NotebookEdit`, a subagent call, a relative path, `Bash`, a missing id or file.
- [x] 1.2 The HTTP side: `POST /agent-typewriter/hook` answered `200 {}`; `Origin`, non-JSON content type, over 16 MB and non-object bodies refused. Verify: unit tests against a real listener on `127.0.0.1`.
- [x] 1.3 Hub and followers: the events stream with `x-agent-typewriter: 1`, following on `EADDRINUSE`, taking over when the hub closes, logging once and retrying when another program has the port. Verify: unit tests with two and three listeners on one port, the hub disposed mid-run, and a plain HTTP server holding the port.
- [x] 1.4 `HookLog`: 15-minute, 5000-event bound and `onDidAdd`. Verify: unit test.

## 2. Matching

- [x] 2.1 `AgentContext.turn` optional, `via: 'hook'`; tooltip without a prompt line when there is no turn. Verify: typecheck and a tooltip case.
- [x] 2.2 `matchHook` (window, earliest-after else latest-before, shared `claimed`, rename paths, Windows paths). Verify: unit tests for each `Changes are matched to hook events` scenario.
- [x] 2.3 `TranscriptIndex.refresh(..., files)`; calls are looked up by id among `calls()` (no `call(id)`, see design.md). Verify: unit test reading a transcript outside any candidate folder, and its subagent folder.
- [x] 2.4 Correlator: hook match first, wait for the transcript call until settle, then event-only context; claim held while waiting; a pass on `onDidAdd`. Verify: unit tests with a fake clock: hook plus transcript, transcript written late, transcript unreadable, hook arriving after the change, hook and transcript naming the same call.

## 3. Wiring and docs

- [x] 3.1 `agentTypewriter.hookPort` in `package.json` (application scope, 0 or 1024–65535), read from user settings only in `config.ts`; not in `repoSettings.ts` or the repository schema. Verify: typecheck, `test/repoSettings.test.ts`, a config unit test that a workspace value is ignored.
- [ ] 3.2 `extension.ts`: listener lifecycle on `hookPort` and `agentContext`, the `HookLog` into the correlator, the output channel. Verify: `npm run it` on CI.
- [ ] 3.3 *Copy Claude Code Hook Settings* command: sets the default port when 0, copies the hooks JSON, says where to paste it. Verify: unit test of the JSON it builds; integration test that the command sets the port and a posted event reaches a recorded change's context.
- [ ] 3.4 Docs: hook setup on the site's Panels page (or a new page), `CHANGELOG.md`. Verify: `npm run build` in `site/`.
- [ ] 3.5 Full check: `npm run typecheck`, `npm test`, CI integration tests on Ubuntu and Windows.

## Workflow follow-up

- Archive this change on the PR branch once CI is green and review is done.
