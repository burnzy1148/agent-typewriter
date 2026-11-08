# Proposal

## Why

Agent context (`agent-context`) ties a recorded change to the Claude Code tool call that made it by reading session transcripts and matching on file and time. That works, but it is a guess: it depends on finding the session's project folder from the checkout's path, on the terminal and VS Code sharing one `CLAUDE_CONFIG_DIR`, and on time windows. People who run Claude Code in a terminal and watch replay in VS Code can tell the extension exactly which call wrote which file: Claude Code's `PostToolUse` hook knows the tool call id, the file, the session and the transcript. (The Claude Code plugin already gets this inside Claude Code; this is for the VS Code extension.)

## What Changes

- **An optional hook listener.** A new setting, `agentTypewriter.hookPort`, off (`0`) by default. When set, the extension listens on `127.0.0.1` at that port for Claude Code HTTP hook requests. Claude Code's `PostToolUse` hook for the edit tools (`Edit`, `MultiEdit`, `Write`, `NotebookEdit`) posts the hook input there. The listener keeps, in memory and for a short while, the session id, prompt id, transcript path, tool name, tool call id, file and subagent of each request, and when it arrived.
- **Several VS Code windows share the port.** The first window to listen on it takes the requests and passes each one to the other windows, which connect to it. When that window closes, another one takes the port over.
- **Hook events are the first thing a change is matched to.** A recorded change whose file an edit hook event names, with the event arriving within a short margin of the write, gets that exact tool call as its agent context, marked as matched by a hook. The turn, prompt and what the agent said still come from the transcript, which is now read from the path the hook names, wherever it is. When that transcript cannot be read, the change still gets the session, tool call and subagent, without a turn.
- **Disk watching still records every change.** The hook does not record anything and does not change which changes are recorded or how they replay; it only attaches context. Without the hook, everything works as before.
- **A command to set it up.** *Agent Typewriter: Copy Claude Code Hook Settings* turns the listener on (picking a port if none is set) and copies the hook settings to paste into Claude Code's `settings.json`.
- **`agentTypewriter.agentContext` stays the master switch.** While it is off, the listener is closed too.

Out of scope:
- Recording changes from the hook instead of from disk (a hook-only capture mode).
- Hooks for `Bash` or other commands. A command's writes are still matched from the transcript.
- Other hook events (`PreToolUse`, `UserPromptSubmit`) and other agents.
- Editing Claude Code's settings files for the user.
- Saving hook events or the context they give across reloads.

## Capabilities

### New Capabilities

- `claude-code-hook`: the hook listener: the setting, which requests it accepts, what it keeps, how windows share the port, and the setup command.

### Modified Capabilities

- `agent-context`: changes are matched to hook events first; transcripts named by hook events are read; the turn may be unknown for a hook match; the setting closes the listener.
- `agent-context` reload requirement: context that came only through a hook event is not guaranteed to be rebuilt after a reload. *Added in implementation* (review round 1): the reload requirement promised every context from transcripts that still exist, which saving no hook events (out of scope above) cannot keep.
- `repo-settings`: user-only settings (`hookPort`) are an exception to "every setting can come from the file", beside `profiles`. *Added in implementation* (review round 1): the Impact section already said the file does not accept the setting, but the capability was not listed.

## Impact

- New `src/hookListener.ts`: the localhost listener and the hand-off between windows (plain Node `http`, no `vscode`).
- `src/agentContext.ts`: hook events as a match source, `via: 'hook'`, an optional `turn`.
- `src/transcripts.ts`: reading transcript files named by hook events, and looking a call up by id.
- `src/timelineView.ts`: the tooltip without a prompt when the turn is unknown.
- `src/config.ts`, `src/extension.ts`, `package.json`: the setting, the command and the wiring. The setting is user-level only, not accepted in workspace settings or the repository settings file, because it opens a port.
- `site/`: how to set up the hook. `CHANGELOG.md`.
- Tests: unit tests for the listener (real localhost sockets), hook matching and the correlator.
