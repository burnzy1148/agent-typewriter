# Design

## Context

`agent-context` (archived as `2026-11-07-transcript-correlation`) attaches an `AgentContext` to recorded changes after they reach the `Timeline`. A `Correlator` reads Claude Code transcripts through a `TranscriptIndex` and matches by file and time. Its design left two seams for this change: `via` is a union so a `'hook'` value fits, and a change that already has `agent` is skipped.

Claude Code hooks (code.claude.com/docs/en/hooks):
- A hook can be `"type": "http"` with a `url`. Claude Code POSTs the hook input as JSON. A refused connection is a non-blocking error: the tool call goes on.
- `PostToolUse` input holds `session_id`, `prompt_id`, `transcript_path`, `cwd`, `hook_event_name`, `tool_name`, `tool_input`, `tool_response`, `tool_use_id`, and `agent_id`/`agent_type` when a subagent made the call. No timestamp. `tool_input.file_path` (`notebook_path` for `NotebookEdit`) is the file. `tool_response` can hold the whole file.
- Hooks in `~/.claude/settings.json` apply to every project. Subagent tool calls fire the same hooks.
- The hook runs after the tool returns, so the request arrives just after the write.

## Goals / Non-Goals

**Goals:**
- Exact tool call attribution for edit tools, with no shell script, on macOS, Linux and Windows.
- Find the transcript from the hook, so sessions started outside a recorded folder, or with another `CLAUDE_CONFIG_DIR`, still get their turn and narration.
- No effect on Claude Code when VS Code is closed or the listener is off, and none on recording or replay.

**Non-Goals:**
- Authenticating the hook. See Risks.
- `Bash` attribution from the hook. `PostToolUse` gives a command's end and no files; the transcript already has its start and end.

## Decisions

### Transport: Claude Code's HTTP hook to a localhost listener

The extension listens on `127.0.0.1:<hookPort>` (Node `http`). The hook settings the setup command copies:

```json
{
  "hooks": {
    "PostToolUse": [
      {
        "matcher": "Edit|MultiEdit|Write|NotebookEdit",
        "hooks": [{ "type": "http", "url": "http://127.0.0.1:47323/agent-typewriter/hook", "timeout": 5 }]
      }
    ]
  }
}
```

Alternatives:
- A `command` hook that writes stdin to a spool folder the extension watches. It needs a shell line that works in bash, Git Bash and PowerShell, atomic writes (temp file and rename), and pruning by both sides; files pile up while VS Code is closed, each possibly as large as the edited file. Rejected.
- A Node script shipped with the extension, run by a `command` hook. The extension's folder changes with every version, and the native Claude Code install does not need Node. Rejected.

The port is fixed, not random, because the hook settings hold it. Default for the setup command: 47323. The setting has `"scope": "application"` and is read with `inspect().globalValue`, so only user settings count: a repository must not be able to open a port.

### Request handling

`POST /agent-typewriter/hook` only. Refused with no state kept: any `Origin` header (403), a content type that is not `application/json` (415), a body over 16 MB (413, reading stops), a body that is not a JSON object (400). Together these keep web pages out: a browser cannot send `application/json` cross-origin without a preflight the listener never answers, and it always sends `Origin` on such a request. Everything else is answered `200 {}` at once.

From the body the listener builds a `HookEvent`:

```ts
interface HookEvent {
  session: string;        // session_id
  prompt?: string;        // prompt_id
  transcript?: string;    // transcript_path
  tool: string;           // tool_name, one of EDIT_TOOLS
  id: string;             // tool_use_id
  file: string;           // tool_input.file_path ?? notebook_path, resolved against cwd
  subagent?: { id: string; type?: string };
  time: number;           // arrival, stamped by the window that took the request
}
```

Anything that is not a `PostToolUse` of an edit tool with a session, a tool call id and a file is answered `200 {}` and dropped. `tool_input` text and `tool_response` are never kept.

### Sharing the port between windows

Each VS Code window runs its own extension host, and only one can listen on the port. `HookListener`:

1. Tries to listen. On success it is the *hub*: it takes hook requests, and serves `GET /agent-typewriter/events` as a stream of newline-delimited `HookEvent` JSON, with the header `x-agent-typewriter: 1`. Every accepted event goes to its own window and to each open stream.
2. On `EADDRINUSE` it connects to `/agent-typewriter/events`. With the header present it is a *follower*: each line is an event for its window.
3. When the stream ends or fails, it waits about 1 s and starts again at step 1: one follower wins the port, the others follow it.
4. Without the header, or when the connection is refused or answered with anything else, the port belongs to another program. It logs that once and retries every 10 s.

The hub stamps `time`, so every window sees the same arrival time from the same clock. Events posted during a takeover (about a second) are lost; those changes fall back to transcript matching. Each line carries `v: 1`; a window ignores lines it does not understand, so mixed extension versions degrade to no events instead of wrong ones.

Alternative: every window on its own random port, registered in a shared folder, with a `command` hook fanning out. Brings back the shell problems above. Rejected.

### Keeping events

A `HookLog` holds events for 15 minutes (`FORGET_MS`, already the transcript index's), at most 5000, and fires `onDidAdd`. The correlator schedules a pass on it, as it does on a timeline change, so a change that reached the timeline before its hook event is matched without waiting for the 2 s retry.

*Superseded in implementation:* scheduling "as it does on a timeline change" leaves a pending retry where it is. See Corrected in implementation, C1.

### Matching

`matchHook(change, events, claimed)` in `agentContext.ts`, pure, run before `matchChange` for each waiting change:

- Candidates: events whose `file` equals one of the change's paths (same normalization as `matchChange`), whose `id` is not in `claimed`, with `change.time - 1000 <= event.time <= change.time + 10_000` (`START_SLACK_MS`, `HOOK_LATE_MS`).
- Pick the earliest with `event.time >= change.time`, else the latest before it. The request follows the write it reports, so the first event after the change's time is the write that produced the change's final text. When a burst folds two edits into one change, the event of the earlier edit is left unclaimed; it is older than every later change's time, so later changes do not take it unless within the 1 s slack.
- `claimed` is shared with transcript matching and holds tool ids of `'edit'` and `'hook'` matches, so one call never gives context to two changes whichever way it was found.

*Superseded in implementation:* the window alone lets a change still waiting take the event of a later write to its file. See Corrected in implementation, C4.

The context: `session` from the event; `tool` `{ id, name, time, detail: basename(file) }`; `subagent` from the event. Then the transcript call with the same id, if the index has it, supplies `turn`, `narration`, the subagent's `description`, and `tool.time` (its start). `via: 'hook'`.

When the event matches but the index has no call with that id yet, the change keeps waiting (the transcript line may be written after the hook request, and the subagent's turn may need its parent's line). Once the change is 30 s past first seen (`SETTLE_MS`), it is settled with the event-only context, without `turn`. The event stays claimed by the change from the first pass that saw it through tracking it in the correlator's per-change state, so another change cannot take it while this one waits.

*Superseded in implementation:* worded more precisely in Corrected in implementation, C2.

### `turn` becomes optional

`AgentContext.turn?: Turn`. Only an event-only hook match leaves it out. The tooltip drops the **Prompt** line without it. Captions and chapters (at-3hc.3, at-3hc.4) are not built yet; chapters will treat it like a change with no context for grouping.

Alternative: a placeholder turn from `prompt_id` with an empty prompt. Consumers could not tell a real empty prompt from an unknown one. Rejected.

### Reading the transcripts hooks name

`TranscriptIndex.refresh(roots, since, files)` gains `files`: transcript paths from kept hook events whose match is still open. Each is read like a candidate transcript (incrementally, whatever its mtime, since the event says it is live), followed by its `<session>/subagents` folder. A path must be absolute and end in `.jsonl`; others are ignored. `TranscriptIndex.call(id)` returns a call by id if its turn is known.

*Superseded in implementation:* there is no `call(id)`; see Corrected in implementation, C3. "Whose match is still open" was first implemented as every kept event; see C5.

### Lifecycle and settings

`extension.ts` creates the `HookListener` when `agentContext` is on and the user-level `hookPort` is a valid port, and disposes it when either changes. Disposing closes the server, every stream and any follower connection. The setup command writes `hookPort` to `ConfigurationTarget.Global` when it is `0`, then copies the JSON above with the port filled in and shows where to paste it.

## Corrected in implementation

Written during implementation and review (PR #98). The passages above are left as proposed.

- **C1. Pass on a hook event.** The correlator schedules a pass 250 ms after `onDidAdd`, moving a pending 2 s retry earlier; a timeline change still leaves a pending retry where it is, as before. What produced the original wording: it assumed the timeline path already moved retries earlier. It does not, and a test with a late hook event waited the full retry.
- **C2. Waiting for the transcript call.** The change waits until the index has a call with the event's id and a known turn (a call without a known turn is not in `calls()`). The correlator remembers the event per waiting change, and adds it to `claimed` on every pass. Same behavior as proposed, said precisely.
- **C3. No `call(id)`.** The correlator looks a hook's call up by id among `calls()`, which holds only calls whose turn is known, so the index needs no new lookup. What produced the original: the proposal planned the lookup before checking that `calls()` already filters on a known turn.
- **C4. An event belongs to the latest write on its file before it arrived** (review round 1). `matchHook` also takes the timeline's changes, and skips an event when another change on its file was written after this change and no later than the event's arrival. A change can reach the timeline after its own hook event (reorder window, debounce, settle), so an event arriving more than 1 s (`START_SLACK_MS`) after the waiting change's write is held: that change may not take it until the event is older than the write lag (reorder window + recorder debounce + 2 s, from settings). Meanwhile the change still tries the transcript rules, and keeps waiting if they find nothing. What produced the original: the window was designed around one write per event and treated a change still waiting as if it were the latest write on its file. The reviewer's case: the user saves a file, the agent edits it 5 s later, and the save took the agent's call while the edit got none. The spec requirement gains "no later write on that file was recorded before it arrived" and the scenario *User save, then an agent edit*; the hold is its own requirement, *Late hook events wait for later writes*. The plan said "no later than 1 s after the event's arrival"; implemented as "no later than the arrival", because a recorded write time is its mtime, which comes before the hook request, and the 1 s slack would hand an event to a second write up to 1 s after the one it reported.
- **C5. Which hook transcripts are read** (review round 1). Only transcripts of kept events whose file is a path of a change still waiting, or whose event a waiting change holds. The first implementation passed every kept event's transcript, which read up to 15 minutes of unrelated sessions on each pass.
- **C6. Relative file paths** (review round 1). `tool_input.file_path` relative to `cwd` is resolved in `cwd`'s own style (`path.posix` for a POSIX-absolute `cwd`, `path.win32` otherwise), not the host's. The host's `path.resolve` turned `/w` + `n/x.ipynb` into `D:\w\n\x.ipynb` on Windows.
- **C7. `hookPort` values** (review round 1). The setting is an `integer`, `0` or 1024 to 65535 in its schema, and its description says ports below 1024 count as off. A user value the extension ignores is logged once in the output channel. The first schema allowed 1 to 1023 and fractions, which `config.ts` silently treated as off.
- **C8. Specs this change touches that the proposal did not name** (review round 1). `repo-settings` promised every setting could come from `.agent-typewriter.json`; `hookPort` cannot, so its requirements name user-only settings as an exception. `agent-context`'s reload requirement promised context comes back from transcripts that still exist; context found only through a transcript a hook event named, outside the folders that are read, is not guaranteed to come back, since hook events are not saved (already out of scope in the proposal). It can come back: a new hook event naming the same transcript while the restored change still waits gets that transcript read, and the transcript rules may then find the original call. Round 2 reworded a first "SHALL NOT be rebuilt" to say so.

## Risks / Trade-offs

- [Any local process can post events] It can only attach wrong context to changes in memory; it cannot write files or change replay. Web pages are kept out (see Request handling). A shared-secret header via `allowedEnvVars` would need the user to set an environment variable for Claude Code; left out to keep setup to one paste.
- [Port collision] Another program on 47323: logged, retried, and the user can pick another port.
- [Lost events] Events during a hub takeover, or before the extension activated, are lost; those changes are matched from transcripts as before.
- [Clocks] Arrival time and the file's mtime are the same machine's clock. On file systems with coarse mtimes (2 s on FAT), the 1 s slack can miss: the change falls back to transcript matching.
- [Remote workspaces] The extension runs where the workspace is; Claude Code must run on the same host for `127.0.0.1` to reach it. Same constraint as the file paths.

## Migration Plan

None. The listener is off until the user sets a port. Rollback is removing the setting.
