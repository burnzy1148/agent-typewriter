# agent-context Specification

## Purpose
Links each recorded change to what the coding agent was doing when it made it: the Claude Code session, the turn and its prompt, the tool call, and what the agent said, so replay can explain why a change happened.

## Requirements

### Requirement: Changes are matched to Claude Code tool calls
A recorded change that no hook event matches SHALL get agent context when a Claude Code transcript holds an edit tool call (`Edit`, `MultiEdit`, `Write` or `NotebookEdit`) on the change's file that started no later than 1 s after the file was written and ended no earlier than 2 s before it, or was still running. Of several such calls, the latest one started at or before the write SHALL be chosen. Each call SHALL give context to at most one change.

#### Scenario: Edit call
- **WHEN** Claude Code runs `Edit` on `src/a.ts` in the recorded checkout and the change is recorded
- **THEN** the change's context names that session, the turn the call belongs to, and the call's id and name `Edit`
- **AND** says it was matched by an edit call

#### Scenario: Two edits to one file
- **WHEN** Claude Code edits `src/a.ts` twice, a few seconds apart, and two changes are recorded
- **THEN** the first change gets the first call and the second change the second call

#### Scenario: A rename matches either path
- **WHEN** a recorded rename's old or new path is the file of a matching edit call
- **THEN** the rename gets that call's context

#### Scenario: User edit later
- **WHEN** the user saves `src/a.ts` a minute after Claude Code's last edit call on it ended, with no tool call running
- **THEN** that change gets no agent context

### Requirement: Changes are matched to running commands
A change that no edit call matches SHALL get the context of a `Bash` call that started no later than 1 s after the file was written and ended no earlier than 2 s before it, or was still running. If such calls of more than one session qualify, the change SHALL get no context. If several calls of one session qualify, the change SHALL get that turn without a tool call. A call SHALL count as running for at most 10 minutes after it started.

#### Scenario: File written by a command
- **WHEN** Claude Code runs `Bash` with `npm run format` and that rewrites `src/b.ts` while it runs
- **THEN** the change to `src/b.ts` gets the call's context, with tool name `Bash`
- **AND** says it was matched by a running command

#### Scenario: Commands from two sessions
- **WHEN** two Claude Code sessions each have a `Bash` call running when `src/b.ts` is written
- **THEN** the change gets no agent context

#### Scenario: Parallel commands in one session
- **WHEN** one turn has two `Bash` calls running when `src/b.ts` is written
- **THEN** the change gets that turn and no tool call

### Requirement: Agent context contents
Agent context SHALL hold the Claude Code session id; when the turn is known, the turn's id, start time and prompt text, without system reminders and cut to 1000 characters; the tool call's id, name, start time and a short detail when known; the latest text the agent wrote in the turn at or before the call, cut to 1000 characters; and, when a subagent made the change, the subagent's id, type and description, with the turn of the call that started it. The turn SHALL be unknown only for a hook match whose transcript call was not found.

#### Scenario: Narration before the call
- **WHEN** the agent writes "Renaming the helper." and then calls `Edit`
- **THEN** the matched change's context holds "Renaming the helper." as what the agent said

#### Scenario: Subagent edit
- **WHEN** a subagent started by an `Agent` call edits `src/c.ts`
- **THEN** the change's context names the subagent and the turn the `Agent` call belongs to

#### Scenario: Prompt without reminders
- **WHEN** a turn's prompt holds a `<system-reminder>` block followed by "Fix the parser"
- **THEN** the context's prompt is "Fix the parser"

### Requirement: Transcripts that are read
Transcripts SHALL be read from `projects` in `$CLAUDE_CONFIG_DIR`, or in `~/.claude` when it is not set. Only project folders named for a recorded checkout, a folder above one, or a folder inside one SHALL be read, with the subagent transcripts of their sessions, plus the transcripts that kept hook events name and their subagent transcripts. Transcripts SHALL only be read, never written, and only when a recorded change has no context yet.

#### Scenario: Session started above the checkout
- **WHEN** a Claude Code session started in `/work` edits `/work/repo/a.ts` and `/work/repo` is recorded
- **THEN** its transcript is read and the change is matched

#### Scenario: Unrelated project
- **WHEN** a Claude Code session runs in `/elsewhere` and no hook event names its transcript
- **THEN** its transcript is not read

### Requirement: Matching waits for the transcript
A change SHALL be matched even when its tool call reaches the transcript after the change is recorded, as long as it arrives within 30 s of the recording. Matching SHALL NOT delay recording or playback.

#### Scenario: Transcript written late
- **WHEN** a change is recorded and the transcript line for its call is written 2 s later
- **THEN** the change gets that call's context

### Requirement: Agent context does not affect recording or replay
Agent context SHALL NOT change which changes are recorded, their order, their before and after text, or how they are replayed.

#### Scenario: Same replay with or without context
- **WHEN** the same edits are recorded once with `agentTypewriter.agentContext` on and once with it off
- **THEN** the timelines hold the same changes with the same text, in the same order

### Requirement: Agent context is rebuilt after a reload
Agent context SHALL NOT be written to the saved timeline or to saved session files. After the timeline is restored, its changes SHALL be matched again from the transcripts that still exist. Hook events are not saved, so context that came only from a hook event, or from a transcript only a hook event named outside the folders that are read, is not guaranteed to be rebuilt.

#### Scenario: Reload
- **WHEN** VS Code reloads with a restored timeline whose Claude Code transcripts still exist
- **THEN** the restored changes get their agent context again

#### Scenario: Saved session file
- **WHEN** the user saves the session to a file
- **THEN** the file holds no agent context

#### Scenario: Reload after a session started elsewhere
- **WHEN** a change got its context from a hook event whose transcript is outside the folders that are read, VS Code reloads, and no new hook event names that transcript within 30 s
- **THEN** the restored change has no agent context

### Requirement: Changes view shows agent context
A change's tooltip in the Changes view SHALL show, when it has agent context, the turn's prompt when the turn is known, the tool call's name and detail, and what the agent said, each shortened to fit.

#### Scenario: Tooltip
- **WHEN** a change matched to an `Edit` call has context
- **THEN** its tooltip shows the turn's prompt, `Edit`, and what the agent said before the call

#### Scenario: Tooltip without a turn
- **WHEN** a change matched to a hook event has context without a turn
- **THEN** its tooltip shows the tool call and no prompt

### Requirement: Agent context setting
The setting `agentTypewriter.agentContext` SHALL turn agent context on or off, on by default, SHALL apply without a restart, and SHALL be accepted in the repository settings file. While it is off, no transcript SHALL be read and the hook listener SHALL be closed.

#### Scenario: Turned off
- **WHEN** `agentTypewriter.agentContext` is `false` and Claude Code edits a recorded file
- **THEN** no transcript is read and the change gets no agent context

### Requirement: Changes are matched to hook events
Before any transcript match, a recorded change SHALL get the context of an edit hook event (`claude-code-hook`) that names the change's file (or either path of a rename), arrived from 1 s before the write to 10 s after it, whose call has given context to no other change, and before whose arrival no later write on that file was recorded. Of several, the earliest arriving at or after the write SHALL be chosen, otherwise the latest before it. The context SHALL say it was matched by a hook.

#### Scenario: Edit reported by the hook
- **WHEN** the hook listener is on, Claude Code's `PostToolUse` hook posts an `Edit` call on `src/a.ts`, and the change to `src/a.ts` is recorded
- **THEN** the change's context names that session and the call's id and name `Edit`
- **AND** says it was matched by a hook

#### Scenario: Two edits to one file
- **WHEN** the hook posts two `Edit` calls on `src/a.ts` a second apart, and two changes are recorded
- **THEN** the first change gets the first call and the second change the second call

#### Scenario: User edit later
- **WHEN** the user saves `src/a.ts` a minute after the last hook event on it, with no tool call running
- **THEN** that change gets no agent context

#### Scenario: User save, then an agent edit
- **WHEN** the user saves `src/a.ts`, an `Edit` call writes `src/a.ts` 5 s later, and the hook posts that call before the edit's change reaches the timeline
- **THEN** the edit's change gets the `Edit` call
- **AND** the user's save does not

### Requirement: Late hook events wait for later writes
A hook event arriving more than 1 s after a change's write SHALL NOT be given to that change until a later write on its file, recorded before the event arrived, could no longer still reach the timeline. While it waits, the change SHALL still be matched by the transcript rules.

#### Scenario: Late event with no later write
- **WHEN** the hook posts an `Edit` call on `src/a.ts` 5 s after the change to `src/a.ts` was written, and no later write on `src/a.ts` is recorded
- **THEN** the change gets the `Edit` call a few seconds later

### Requirement: Hook matches take the turn from the transcript
For a change matched to a hook event, the turn, the prompt, what the agent said and the subagent's description SHALL come from the call with the event's tool call id in the transcript the event names, read whatever folder it is in. When that call is not found within 30 s of the recording, the change SHALL get the session, the tool call and the subagent from the event, without a turn.

#### Scenario: Session started elsewhere
- **WHEN** a Claude Code session started in `/elsewhere` edits `/work/repo/a.ts`, `/work/repo` is recorded, and the hook posts the call
- **THEN** the session's transcript is read and the change gets the call's turn, prompt and what the agent said

#### Scenario: Transcript cannot be read
- **WHEN** the hook posts an `Edit` call on `src/a.ts` whose transcript path cannot be read
- **THEN** 30 s after the change is recorded it gets the session and the `Edit` call, without a turn
