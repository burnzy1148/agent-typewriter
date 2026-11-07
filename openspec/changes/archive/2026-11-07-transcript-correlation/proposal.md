# Proposal

## Why

The extension replays what changed but not why. When Claude Code made the change, its session transcript (`~/.claude/projects/<project>/<session>.jsonl`) already records the prompt that started the turn, the tool call that wrote the file, and what the agent said before it. Linking each recorded change to that context is the base the agent-context epic builds on. Captions (at-3hc.3) need the agent's words for a change, and chapters (at-3hc.4) need the turn each change belongs to.

## What Changes

- **Changes get agent context.** After a change is recorded, the extension looks for it in the Claude Code transcripts of the recorded checkout and, when it finds a match, attaches it to the change. The context holds the Claude Code session, the turn (its id, time and prompt), the tool call (id, name, time, a short detail) when that can be told, the last thing the agent said in the turn before the call, the subagent when one made the change, and how the match was made.
- **Two ways to match.**
  - *Edit*: an edit tool call (`Edit`, `MultiEdit`, `Write`, `NotebookEdit`) on the same file whose call started before the file was written, and ended no more than a short margin before it. Each call is matched to at most one change.
  - *Command*: when no edit call matches, a `Bash` call that was running when the file was written. If calls from more than one session were running, the change gets no context. If more than one call of the same session was running, the change gets the turn but no tool call.
  - Anything else, such as the user's own edits, gets no context.
- **Where transcripts are found.** In `$CLAUDE_CONFIG_DIR/projects`, or `~/.claude/projects` when that variable is not set. Only project folders for a recorded checkout, a folder above it, or a folder inside it are read, plus their subagent transcripts. The extension only reads them, and only files written to around the time of a change it has not matched yet.
- **The Changes view shows it.** A change's tooltip shows the turn's prompt, the tool call and what the agent said.
- **Context is rebuilt after a reload.** It is kept in memory, not in the saved timeline or in saved session files. After a reload, restored changes are matched again from the transcripts that still exist.
- **New setting `agentTypewriter.agentContext`**, on by default. Turning it off stops all transcript reading. Like every other setting, it can also be set in `.agent-typewriter.json`.

Out of scope:
- Captions and chapters themselves (at-3hc.3, at-3hc.4). This change only provides the data they read.
- A Claude Code hook as a capture path (at-3hc.1). The context's shape leaves room for it: a hook supplies the session and tool call ids, and the same context can be built from them.
- Saving agent context in the timeline log or in saved session files.
- Transcripts of other agents than Claude Code.

## Capabilities

### New Capabilities

- `agent-context`: how recorded changes are linked to what the agent was doing when it made them: matching against Claude Code transcripts, what the context holds, where it is shown, and the setting that controls it.

### Modified Capabilities

None. Recording, the timeline, playback and persistence behave as before; the context is attached beside them.

## Impact

- New `src/transcripts.ts`: finds and incrementally reads Claude Code transcripts into an index of turns and tool calls (pure Node, no `vscode`).
- New `src/agentContext.ts`: the `AgentContext` type, the matching rules (pure), and the correlator that watches the timeline and attaches context.
- `src/timeline.ts`: an optional `agent` field on `ChangeEvent`, a method to attach context to recorded changes, and `toSession` leaving the field out.
- `src/timelineView.ts`: the tooltip.
- `src/config.ts`, `src/repoSettings.ts`, `schemas/agent-typewriter.schema.json`, `src/extension.ts`, `package.json`: the setting and the wiring.
- `site/src/content/docs/docs/panels.md`: the tooltip and the setting in the Changes view docs.
- Tests: unit tests for transcript parsing, project-folder selection, matching, and the correlator; a Changes view tooltip test.
