## Purpose

Lets Claude Code tell the extension which tool call wrote which file: a local listener takes Claude Code's `PostToolUse` HTTP hook requests and keeps them briefly so recorded changes can be matched to their exact tool call.

## ADDED Requirements

### Requirement: Hook port setting
The setting `agentTypewriter.hookPort` SHALL turn the hook listener on when it is a port from 1024 to 65535, and off when it is `0`, the default. The listener SHALL accept connections on `127.0.0.1` only. A change to the setting SHALL apply without a restart. Only the user settings value SHALL count: workspace settings and the repository settings file SHALL NOT turn the listener on.

#### Scenario: Turned on
- **WHEN** the user sets `agentTypewriter.hookPort` to `47323` in user settings
- **THEN** the extension accepts hook requests at `http://127.0.0.1:47323/agent-typewriter/hook` without a reload

#### Scenario: Off by default
- **WHEN** `agentTypewriter.hookPort` is not set
- **THEN** the extension listens on no port

#### Scenario: Repository file cannot open a port
- **WHEN** a checkout's `.agent-typewriter.json` sets `hookPort` to `47323` and user settings do not
- **THEN** the extension listens on no port

#### Scenario: Agent context off
- **WHEN** `agentTypewriter.hookPort` is `47323` and `agentTypewriter.agentContext` is `false`
- **THEN** the extension listens on no port

### Requirement: Accepted hook requests
The listener SHALL accept a `POST` to `/agent-typewriter/hook` with a JSON content type and a Claude Code hook input as its body, and SHALL answer it at once with status 200 and an empty JSON object, so the hook never holds Claude Code up or changes what it does. It SHALL refuse a request that carries an `Origin` header, one that is not JSON, and one whose body is over 16 MB, and SHALL keep nothing from them.

#### Scenario: Hook request
- **WHEN** Claude Code's `PostToolUse` hook posts the input of an `Edit` call to the listener
- **THEN** the listener answers 200 with `{}` and keeps the event

#### Scenario: Request from a web page
- **WHEN** a request to the listener carries an `Origin` header
- **THEN** it is refused and nothing is kept

#### Scenario: Not a tool call on a file
- **WHEN** a valid hook request is for a tool other than `Edit`, `MultiEdit`, `Write` or `NotebookEdit`, or names no file
- **THEN** the listener answers 200 with `{}` and keeps nothing

### Requirement: What a hook event holds
For an accepted `PostToolUse` request of an edit tool, the extension SHALL keep the session id, the prompt id, the transcript path, the tool name, the tool call id, the file as an absolute path (resolved against the request's working folder when relative), the subagent's id and type when a subagent made the call, and the time the request arrived. It SHALL NOT keep the tool's input text or its response. Events SHALL be kept in memory only, for 15 minutes.

#### Scenario: Subagent call
- **WHEN** a subagent's `Write` call is posted with its `agent_id` and `agent_type`
- **THEN** the kept event names that subagent and its type

#### Scenario: Not kept across a reload
- **WHEN** VS Code reloads
- **THEN** the hook events received before the reload are gone

### Requirement: Windows share the hook port
When several VS Code windows have the same hook port set, one window SHALL take the hook requests and SHALL pass every accepted event to the others, so each window gets every event. When that window closes, another window SHALL take the port over within a few seconds.

#### Scenario: Two windows
- **WHEN** two VS Code windows both set the hook port to `47323` and Claude Code posts an `Edit` event
- **THEN** both windows keep the event

#### Scenario: Taking over
- **WHEN** the window that took the port closes and Claude Code posts an event five seconds later
- **THEN** the remaining window keeps it

### Requirement: Port taken by another program
When the hook port is taken by a program that is not another Agent Typewriter window, the extension SHALL say so once in its output channel and SHALL keep trying to listen, without error dialogs.

#### Scenario: Port in use
- **WHEN** another program listens on `127.0.0.1:47323` and the user sets the hook port to `47323`
- **THEN** the output channel says the port is in use, and the listener starts once the port is free

### Requirement: Hook setup command
The command *Agent Typewriter: Copy Claude Code Hook Settings* SHALL copy to the clipboard the Claude Code settings that post `PostToolUse` events of `Edit`, `MultiEdit`, `Write` and `NotebookEdit` to the listener's URL, and SHALL say where to paste them. When the hook port is `0`, it SHALL first set it in user settings to a default port.

#### Scenario: Setting up
- **WHEN** the user runs the command with `agentTypewriter.hookPort` at `0`
- **THEN** the port is set to the default in user settings, the listener starts, and the clipboard holds a `hooks` block whose URL uses that port
