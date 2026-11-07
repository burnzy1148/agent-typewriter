# Design

## Context

Claude Code appends one JSON object per line to `<config>/projects/<encoded cwd>/<session>.jsonl`. The encoded cwd is the session's start folder with every character outside `[A-Za-z0-9]` replaced by `-`, so `/Users/me/repo/.claude/worktrees/x` becomes `-Users-me-repo--claude-worktrees-x` (on Windows `C:\repo` becomes `C--repo`). The lines that matter:

- `type: "user"` with string content, or a `text` block and no `tool_result`, and no `isMeta`: a prompt that starts a turn. It carries `uuid`, `timestamp` and, in recent versions, `promptId`.
- `type: "assistant"` lines, one content block each: `text` (what the agent says) or `tool_use` (`id`, `name`, `input`). `Edit`/`MultiEdit`/`Write` have `input.file_path`, `NotebookEdit` has `input.notebook_path`, `Bash` has `input.command` and `input.description`.
- `type: "user"` with a `tool_result` block (`tool_use_id`): the call ended at that line's `timestamp`.
- Subagents write `<session>/subagents/agent-<id>.jsonl` in the same shape, with `agentId` on each line, and `agent-<id>.meta.json` holding `toolUseId` (the `Agent` call that started it), `agentType` and `description`.
- Many other line types (API request blobs, snapshots) must be skipped. Some of them repeat `tool_use` blocks inside `message`, so the top-level `type` decides, not the content.

A `tool_use` line is written before the tool runs and its `tool_result` after, so a file the tool wrote has a write time between the two. The recorder sets a change's `time` to the file's mtime, clamped to when the watcher reported it (`change-recording`), and pushes it to the `Timeline` after the reorder window. Both clocks are the same machine's wall clock.

The timeline log (`persistence.ts`) is append-only and its records are immutable once saved. Saves are throttled, not debounced, so a change can be saved before anything learns about it from a transcript.

Sibling work this must serve:
- at-3hc.3 (captions) needs what the agent said for the change being typed.
- at-3hc.4 (chapters) needs a stable turn id per change, its prompt for a title, and an "unknown" for the idle-gap fallback.
- at-3hc.1 (hook capture) will hand the recorder a session id, tool use id and transcript path at record time.
- at-o3z.12 does the same in the Claude Code plugin with `toolUseId`/`turnId`/`agentId` from hooks. The names here follow it.

## Goals / Non-Goals

**Goals:**
- Attach an `AgentContext` to recorded changes without touching how they are recorded, saved or played.
- Keep the transcript reading and the matching pure and unit-testable without VS Code.
- Read little: only candidate project folders, only files written to near an unmatched change, only bytes appended since the last read.

**Non-Goals:**
- Persisting context (log or session files). A follow-up bead covers it.
- Any UI beyond the Changes view tooltip.
- Watching transcripts continuously when nothing is waiting for a match.

## Decisions

### The context type

```ts
interface AgentContext {
  session: string;                                   // Claude Code session id
  turn: { id: string; time: number; prompt: string }; // id = promptId ?? the prompt line's uuid
  tool?: { id: string; name: string; time: number; detail?: string };
  narration?: string;                                 // latest agent text in the turn at or before the call
  subagent?: { id: string; type?: string; description?: string };
  via: 'edit' | 'command';
}
```

`ChangeEvent` gets `agent?: AgentContext`. Captions read `agent.narration`, chapters group by `agent.turn.id` and title by `agent.turn.prompt`. `tool` is optional because a command match can know the turn without the call. `via` is a union so at-3hc.1 can add `'hook'`. `detail` is the `Bash` description (or first line of the command), or the file name for edit tools, cut to 200 characters.

Alternatives: store only ids and resolve text from the transcript on demand. That makes captions and chapters asynchronous and breaks them when the transcript is gone. The texts are shared string references in memory, so carrying them on each event costs little.

### Attach after recording, in memory

A `Correlator` subscribes to `Timeline.onDidChange`, finds changes without context, and calls a new `Timeline.annotate(entries)`, which rebinds those events with `agent` set and emits once. The recorder is not touched. This keeps recording and playback decoupled, never delays a change, and leaves a clean seam for at-3hc.1: a hook-captured change can arrive with `agent` already set, and the correlator skips it.

Context is not saved. The log cannot rewrite a saved record, and a change is often saved before its match is found. Instead, after a restore the correlator treats every restored change as unmatched and tries once. `toSession` drops `agent`, so saved session files stay as they are. Persisting it is a follow-up bead.

Alternative: correlate inside the recorder before `timeline.push`. That needs a synchronous, always-fresh index in the reorder flush, delays playback when the transcript lags, and still loses context in the log when a save beats the match.

### Transcript index (`src/transcripts.ts`, plain Node)

- `projectsDir()`: `$CLAUDE_CONFIG_DIR/projects` or `~/.claude/projects`.
- `encodeProjectPath(p)`: replace `[^A-Za-z0-9]` with `-`.
- `candidateDirs(names, roots)`: a project folder is a candidate when its name equals the encoding of a root or one of its ancestors, or starts with a root's encoding followed by `-`. The prefix rule can include unrelated folders (`/a/b-c` for root `/a/b`). That is harmless, because matching is by absolute file path.
- `TranscriptIndex` keeps per transcript file a byte offset and a partial last line, and reads only what was appended (in chunks, decoding UTF-8 at line boundaries). Parsed lines fill per-session state: the current turn, the last narration of the turn, tool calls `{ id, name, file?, detail, start, end?, turn, narration, agentId? }`, and the time of the file's last line. A line that is not valid JSON is skipped. Subagent files resolve their turn from the main session's call named in `meta.json`. Until that call is indexed, their calls wait in the index and get the turn on the next refresh.
- `refresh(dirs, since)` lists `*.jsonl` in each candidate dir and `<session>/subagents/*.jsonl`, and reads files whose mtime is at least `since - 5 s`. The projects folder listing is cached for 10 s.

### Matching (`src/agentContext.ts`, pure)

`matchChange(change, calls, claimed, now)` with `change = { paths, time }` (absolute paths: the file, plus the old path for a rename):

1. Edit candidates: edit-tool calls with a path equal to one of `paths` (case-insensitive on Windows), not in `claimed`, with `start <= time + 1000` and `time <= (end ?? min(start + 10 min, now)) + 2000`. Prefer the latest with `start <= time`, otherwise the earliest. Result: `via: 'edit'`, and the caller adds the id to `claimed`.
2. Command candidates: `Bash` calls with the same window. If none qualify, there is no context. If they span more than one session, there is no context either. One call gives the turn and tool. Several calls in one session give the turn if they share one, otherwise no context.

`claimed` is rebuilt every pass from the tool ids on changes that already have context with `via: 'edit'`. So the pass is stateless across restores and clears. Calls skipped because a burst folded them into one change are never chosen later: every later change has a later time, so it prefers a later call.

### When the correlator runs

- Debounced 250 ms after a timeline change that leaves an unmatched, unsettled change.
- While any unmatched change is under 30 s old, again every 2 s.
- A change settles once it is matched, or once it is 30 s old and has been tried at least once. Restored changes are old, so they are tried once. Settled keys are `seq:time:uri`, pruned to what is still in the timeline.
- Roots are the recording lanes' roots plus the workspace folders. Off when `agentTypewriter.agentContext` is false. Turning it on runs a pass.
- Errors reading a file are logged once per file to the output channel and do not stop the pass.

## Risks / Trade-offs

- [Transcript format changes] Parsing is defensive: unknown shapes are skipped, and the worst case is no context. Fixtures in tests pin the shapes this relies on.
- [Large transcripts] Sessions with API-request lines reach tens of MB. Only files written near an unmatched change are read, each once from the start, then by appended bytes. The first pass after a reload may read a few large files. It runs off the recording path.
- [Wrong match] A user edit while Claude Code's `Bash` call runs is attributed to that call. The window margins are small, and a wrong caption is the cost.
- [Background commands] `Bash` with `run_in_background` ends at once, so files it writes later get no context.
- [Symlinked paths] A transcript path through a symlink does not equal the recorded path, so the change gets no context.
- [Not persisted] Context is lost after reload once Claude Code has cleaned up the transcript (30 days by default). A follow-up bead covers persisting it.
