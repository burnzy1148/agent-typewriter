# Spec Delta

## Purpose

Defines how the Agent Typewriter plugin for Claude Code records the file edits a Claude Code session makes and replays them as human-like typing in a pane beside the conversation.

## ADDED Requirements

### Requirement: Session edits are recorded
The plugin SHALL record a change for each `Edit` and `Write` tool call that the session runs, including calls made by its subagents. It SHALL NOT record writes made any other way, including by `Bash`, `NotebookEdit`, other programs, or the user.

#### Scenario: Edit in the main conversation
- **WHEN** Claude edits `src/app.ts` with the `Edit` tool and the edit succeeds
- **THEN** one change for `src/app.ts` is recorded

#### Scenario: Write by a subagent
- **WHEN** a subagent of the session creates `notes.md` with the `Write` tool
- **THEN** one change for `notes.md` is recorded, with empty before text

#### Scenario: Shell write
- **WHEN** Claude runs `echo hi > out.txt` with the `Bash` tool
- **THEN** no change is recorded

#### Scenario: Edit outside the session
- **WHEN** the user saves `src/app.ts` in their editor during the session
- **THEN** no change is recorded

### Requirement: Before text is captured when the call starts
A change's before text SHALL be the file's text read when the tool call starts, before the tool runs, and its after text SHALL be the file's text read once the tool has finished. A file that does not exist when the call starts SHALL have empty before text.

#### Scenario: Two edits to one file
- **WHEN** Claude edits `a.ts` from text A to B and then from B to C
- **THEN** two changes are recorded, A to B and B to C, even if neither has been played yet

### Requirement: Only successful changes are recorded
A tool call that is refused, that the tool reports as an error, or that leaves the file's text unchanged SHALL NOT record a change.

#### Scenario: Permission denied
- **WHEN** the user declines an `Edit` call
- **THEN** no change is recorded

#### Scenario: Edit fails
- **WHEN** an `Edit` call fails because its old text is not in the file
- **THEN** no change is recorded

### Requirement: Recording never affects the tool call
Recording SHALL NOT change a tool call's input, result, or permission decision. If recording fails, for example because a file cannot be read, the tool call SHALL run and return as it would without the plugin, and no change SHALL be recorded for it.

#### Scenario: Unreadable file after the edit
- **WHEN** a file cannot be read after a successful `Write`
- **THEN** the `Write` result reaches Claude unchanged and no change is recorded

### Requirement: The plugin never writes files
The plugin SHALL NOT create, modify, or delete any file. It SHALL only read the files that recorded tool calls touched.

#### Scenario: Playback finishes
- **WHEN** a change to `a.ts` finishes playing
- **THEN** `a.ts` on disk is exactly as the tool left it

### Requirement: Changes play in recorded order
Recorded changes SHALL be played one at a time, in the order they were recorded. When a change finishes, the next recorded change SHALL start without user action unless playback is paused.

#### Scenario: Two files edited in turn
- **WHEN** Claude edits `a.ts` and then `b.ts`
- **THEN** the change to `a.ts` is typed first and the change to `b.ts` starts when it finishes

### Requirement: Playback reproduces the after text
Playback SHALL type each change from its before text by deleting and typing text in steps, and when the change finishes the text shown SHALL equal the change's after text exactly.

#### Scenario: Modified line
- **WHEN** a change replaces `return a + b;` with `return a + b + c;`
- **THEN** the pane shows the line being edited in steps, and ends showing the after text

### Requirement: Typing speed setting
The plugin SHALL provide a `charsPerMinute` option that sets the typing speed in characters per minute, defaulting to 1000. A value that is not a number greater than zero SHALL be treated as 1000. A change to the option SHALL apply from the next keystroke.

#### Scenario: Default speed
- **WHEN** `charsPerMinute` is not set
- **THEN** changes are typed at 1000 characters per minute

#### Scenario: Faster speed
- **WHEN** `charsPerMinute` is 3000
- **THEN** a change of 300 inserted characters takes about 6 seconds to type

### Requirement: Natural order setting
The plugin SHALL provide a `naturalOrder` option, defaulting to on. With it on, a change that types a whole block SHALL type it in the order the `authoring-order` capability defines for the VS Code extension. With it off, each change SHALL be typed top to bottom.

#### Scenario: New function with natural order
- **WHEN** `naturalOrder` is on and a change adds a function with a multi-line body
- **THEN** the function's opening and closing lines are typed before its body

### Requirement: Replay pane
The plugin SHALL show an "Agent Typewriter" pane on the terminal, desktop and VS Code surfaces of Claude Code. While a change plays, the pane SHALL show its file, the part of the file's current text around the caret with the caret marked, and line numbers, with syntax highlighting chosen from the file's name.

#### Scenario: Long file
- **WHEN** a change edits line 400 of a 900-line file
- **THEN** the pane shows the lines around the caret, numbered from their place in the file

### Requirement: Pane names the file
The pane SHALL name the playing file by its path relative to the session's working directory, or by its absolute path when it is outside that directory. When nothing is playing, the pane SHALL keep showing the last change's file and after text.

#### Scenario: File in the project
- **WHEN** the session runs in `/w` and a change to `/w/src/app.ts` plays
- **THEN** the pane names it `src/app.ts`

### Requirement: Pane shows playback status
The pane SHALL show whether playback is typing, paused, or idle, and how many recorded changes are waiting to play. Before any change is recorded, it SHALL say that edits Claude makes will be typed out there.

#### Scenario: Changes waiting
- **WHEN** a change is playing and two more are recorded
- **THEN** the pane shows that it is typing and that 2 changes are queued

### Requirement: Opening the pane
A `/typewriter` command SHALL open the pane. When the session records its first change, the pane SHALL also open by itself where Claude Code docks a pane beside the conversation without taking it over: in the desktop app, and in a terminal wide enough. Elsewhere it SHALL stay undrawn until the user runs `/typewriter` or the terminal grows wide enough.

#### Scenario: Desktop app
- **WHEN** the first change of a session in the desktop app is recorded and the pane is not open
- **THEN** the pane opens beside the conversation

#### Scenario: Narrow terminal
- **WHEN** the first change is recorded in a terminal too narrow to dock a pane
- **THEN** the pane is not drawn until the user runs `/typewriter`

#### Scenario: Later changes
- **WHEN** the user closes the pane and the session records more changes
- **THEN** the pane does not open again by itself

### Requirement: Playback controls
The pane SHALL have controls to pause and resume playback, to finish the current change at once, and to skip to the latest change. Pausing SHALL stop typing at the current keystroke, and resuming SHALL continue from there. Skipping to the latest SHALL finish every recorded change at once and show the last one's after text.

#### Scenario: Pause and resume
- **WHEN** the user pauses halfway through a change and later resumes
- **THEN** typing stops, and on resume continues from where it stopped

#### Scenario: Finish current
- **WHEN** the user finishes the current change while two more are queued
- **THEN** the pane shows the current change's after text and the next change starts

#### Scenario: Skip to latest
- **WHEN** the user skips to the latest while three changes are queued
- **THEN** no change is left queued and the pane shows the last recorded change's after text

### Requirement: Recorded changes last for the session
Recorded and queued changes SHALL survive a reload of the plugin within the same session. They SHALL NOT carry over to a new session. At most 200 changes SHALL wait to play. When another is recorded, the oldest waiting change SHALL be dropped.

#### Scenario: New session
- **WHEN** a session ends with changes queued and the user starts a new session
- **THEN** the new session's pane starts with no recorded changes

### Requirement: Large files are not typed
A change to a file larger than 1,000,000 bytes, before or after the tool ran, SHALL NOT be typed, and the plugin SHALL NOT read its text. When it would play, the pane SHALL name its file, say it is too large to replay, and move on to the next change.

#### Scenario: Generated file
- **WHEN** Claude writes a 2 MB generated file
- **THEN** the pane says that file is too large to replay and plays the next change
