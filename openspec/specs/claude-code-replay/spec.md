# claude-code-replay Specification

## Purpose

Defines how the Agent Typewriter plugin for Claude Code records the file edits a Claude Code session makes and replays them as human-like typing in a pane beside the conversation.

## Requirements

### Requirement: Session edits are recorded
The plugin SHALL record a change for each `Edit` and `Write` tool call that the session runs, including calls made by its subagents, except in a session that draws only on the terminal surface. It SHALL NOT record writes made any other way, including by `Bash`, `NotebookEdit`, other programs, or the user.

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

#### Scenario: Session with no surface
- **WHEN** Claude edits `src/app.ts` in a session that draws on no surface, such as a `-p` run or a cloud session
- **THEN** one change for `src/app.ts` is recorded

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

### Requirement: Long deletions are removed at once
As in the VS Code extension, a deletion of at most 24 characters within one line SHALL be backspaced in steps, and a longer deletion, or one that spans lines, SHALL be removed in one step.

#### Scenario: Deleted function
- **WHEN** a change deletes a 200-line function
- **THEN** the function disappears in one step and typing carries on with the next edit

#### Scenario: Renamed identifier
- **WHEN** a change replaces `total` with `sum`
- **THEN** `total` is backspaced a few characters at a time before `sum` is typed

### Requirement: Large insertions are shown at once
As in the VS Code extension with its default settings, a change whose edits insert more than 6,000 characters in all SHALL be shown at once, finished, instead of typed, and the next change SHALL start about a second later.

#### Scenario: Generated file
- **WHEN** Claude writes a new 20 KB file
- **THEN** the pane shows the whole file at once instead of typing it

#### Scenario: Minified line
- **WHEN** a change edits a few characters in a 300,000-character line, which the planner retypes whole
- **THEN** the pane shows the edited line at once

### Requirement: Line endings
The plugin SHALL replay a file with CRLF or CR line endings as if its line endings were LF, so natural order and line numbers work the same for every file.

#### Scenario: CRLF file with natural order
- **WHEN** `naturalOrder` is on and a change adds a function with a multi-line body to a CRLF file
- **THEN** the function's opening and closing lines are typed before its body, as for an LF file

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
The plugin SHALL show an "Agent Typewriter" pane on the desktop and VS Code surfaces of Claude Code. While a change plays, the pane SHALL show its file, the part of the file's current text around the caret with the caret marked, and line numbers, with syntax highlighting chosen from the file's name.

#### Scenario: Long file
- **WHEN** a change edits line 400 of a 900-line file
- **THEN** the pane shows the lines around the caret, numbered from their place in the file

#### Scenario: Long line
- **WHEN** a change edits column 5,000 of a 300,000-character minified line
- **THEN** the pane shows the part of the line around the caret, and the caret stays in view

#### Scenario: Control characters
- **WHEN** the file shown holds a form feed, an escape or another control character other than tab and newline
- **THEN** the pane shows each as a visible symbol and keeps drawing the file

### Requirement: Pane names the file
The pane SHALL name the playing file by its path relative to the session's working directory, or by its absolute path when it is outside that directory, and beside the name SHALL show the number of the change it shows. When nothing is playing, the pane SHALL keep showing the last change's file and after text, except while playback is paused with a change cued to play next, after a pick or a reload, which it shows as it was before that change.

#### Scenario: File in the project
- **WHEN** the session runs in `/w` and a change to `/w/src/app.ts` plays
- **THEN** the pane names it `src/app.ts`

#### Scenario: Waiting after a pick
- **WHEN** a change to `a.ts` has finished playing, playback is paused, and the user presses an earlier change to `b.ts`
- **THEN** the pane names `b.ts` and shows it as it was before that change

#### Scenario: Waiting after a reload
- **WHEN** a change to `a.ts` has finished playing, a change to `b.ts` waits, playback is paused, and the plugin reloads
- **THEN** the pane names `b.ts` and shows it as it was before that change

#### Scenario: Change number
- **WHEN** the third change the session recorded is being typed
- **THEN** the pane shows `#3` beside the file's name

### Requirement: Pane shows playback status
The pane SHALL show whether playback is typing, paused, or idle, and how many recorded changes are waiting to play. Before any change is recorded, it SHALL say that edits Claude makes will be typed out there.

#### Scenario: Changes waiting
- **WHEN** a change is playing and two more are recorded
- **THEN** the pane shows that it is typing and that 2 changes are queued

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
Recorded changes, played or queued, SHALL survive a reload of the plugin within a session, as when an option changes, each with its texts, whether it has played, whether it created its file, and when it was recorded. The change being typed then starts over. Changes SHALL NOT carry over to a new session. Besides the change being typed, at most 200 changes, with at most 20,000,000 characters of before and after text, SHALL be kept; past either limit, the oldest SHALL be dropped, played ones first.

#### Scenario: New session
- **WHEN** a session ends with changes queued and the user starts a new session
- **THEN** the new session's pane starts with no recorded changes

#### Scenario: Reload after changes played
- **WHEN** two changes have played, a third is being typed and a fourth is queued, and the plugin reloads
- **THEN** the two played changes are kept as played and do not play again, the third starts over, and the fourth plays after it

#### Scenario: Reload with nothing left to play
- **WHEN** every recorded change has played and the plugin reloads
- **THEN** the pane names the last change's file and shows its after text, and no change plays again

#### Scenario: Created file
- **WHEN** Claude creates `notes.md` with the `Write` tool and the plugin later reloads
- **THEN** the change to `notes.md` is still kept as creating the file, with the time it was first recorded

#### Scenario: Played changes past the limit
- **WHEN** 150 changes have played and 100 more are recorded before any of them plays
- **THEN** the 50 oldest played changes are dropped and all 100 new ones wait to play

#### Scenario: Change typed past the limit
- **WHEN** a change is being typed and 200 more are recorded behind it
- **THEN** the change being typed is still kept, so it finishes, or starts over after a reload, and all 200 changes recorded behind it are kept too

#### Scenario: Many edits to a large file
- **WHEN** Claude makes 100 edits to a 500 KB file faster than they can be typed
- **THEN** every edit is recorded until the kept text passes 20,000,000 characters, after which the oldest edits are dropped, played ones first, and playback keeps going

### Requirement: Changes saved by an earlier version still load
A change saved by an earlier version of the plugin without whether it had played, its kind or its time SHALL still survive a reload into a version that keeps them. Such a change SHALL wait to play and count as modifying its file, and its time SHALL be 0, which means the time it was recorded is unknown.

#### Scenario: Reload across an update
- **WHEN** changes were queued by a version of the plugin that saved neither their kind nor their time, and the plugin reloads into this version within the same session
- **THEN** those changes play in their recorded order, each counted as modifying its file, with time 0

### Requirement: Large files are not typed
A change to a file larger than 1,000,000 bytes, before or after the tool ran, SHALL NOT be typed, and the plugin SHALL NOT read the file's text at either point. When the file was that large both before and after and its size and modification time did not change, no change SHALL be recorded. When it would play, the pane SHALL name its file, say it is too large to replay, and move on to the next change.

#### Scenario: Generated file
- **WHEN** Claude writes a 2 MB generated file
- **THEN** the pane says that file is too large to replay and plays the next change

### Requirement: Pane opens on request or on the first change
A `/typewriter` command SHALL open the pane, except in a session that draws only on the terminal surface. When the session records its first change, the pane SHALL also open by itself where Claude Code docks a pane beside the conversation without taking it over, as in the desktop app. Elsewhere it SHALL stay undrawn until the user runs `/typewriter`.

#### Scenario: Desktop app
- **WHEN** the first change of a session in the desktop app is recorded and the pane is not open
- **THEN** the pane opens beside the conversation

#### Scenario: Command in the desktop app
- **WHEN** the user runs `/typewriter` in the desktop app while the pane is closed
- **THEN** the pane opens

#### Scenario: Later changes
- **WHEN** the user closes the pane and the session records more changes
- **THEN** the pane does not open again by itself

### Requirement: Terminal sessions are left to the VS Code extension
In a session that draws only on the terminal surface, the plugin SHALL NOT record changes, SHALL NOT read the files that `Edit` and `Write` calls touch, and SHALL NOT open its pane. People who run Claude Code in a terminal replay with the Agent Typewriter extension for VS Code instead.

#### Scenario: Edit in a terminal session
- **WHEN** Claude edits `src/app.ts` in a session that draws only in a terminal
- **THEN** no change is recorded, the plugin does not read `src/app.ts`, and the pane does not open

### Requirement: `/typewriter` in a terminal session points to the extension
In a session that draws only on the terminal surface, `/typewriter` SHALL NOT open the pane. It SHALL answer that Agent Typewriter for Claude Code does not replay in the terminal, and name the Agent Typewriter extension for VS Code and the Claude Code desktop app as the places to watch edits replayed.

#### Scenario: Command in a terminal session
- **WHEN** the user runs `/typewriter` in a session that draws only in a terminal
- **THEN** the pane does not open and the answer points to the Agent Typewriter extension for VS Code

### Requirement: Nothing is drawn on the terminal surface
When a session draws on the terminal and on another surface at once, the plugin SHALL record and draw on the other surface as in any session, and SHALL draw nothing of its own on the terminal surface.

#### Scenario: Terminal and desktop together
- **WHEN** a session draws on the terminal and the desktop app, and Claude edits `src/app.ts`
- **THEN** the change is recorded and typed out in the desktop app's pane, and the terminal shows nothing drawn by the plugin

### Requirement: Pane lists the session's changes
Below the code and the playback controls, the pane SHALL list every change the plugin keeps, oldest first. Each row SHALL show whether its change has played, is being typed, or waits; its number, counting the session's recorded changes from 1 in recorded order; the tool that made it, `Edit` or `Write`; its path, named as the pane names a file; and the lines it adds and removes. A row's number SHALL NOT change for the rest of the session.

#### Scenario: Played, playing and queued
- **WHEN** Claude has made five changes, two have played, the third is being typed and two wait
- **THEN** the list shows five rows numbered 1 to 5, the first two marked played, the third marked as being typed, and the last two marked queued

#### Scenario: What a row shows
- **WHEN** the session runs in `/w` and Claude edits `/w/src/routes/login.ts` with `Edit`, adding one line and removing one
- **THEN** that change's row shows `Edit`, `src/routes/login.ts` and `+1 −1`

#### Scenario: Numbers stay
- **WHEN** the user plays from an earlier change, or the plugin reloads
- **THEN** every row keeps the number it had

#### Scenario: Nothing recorded yet
- **WHEN** no change has been recorded
- **THEN** the pane shows no list and says that edits Claude makes will be typed out there

### Requirement: The list says how many changes were dropped
When older changes have been dropped to stay within the limits on kept changes, the list SHALL begin by saying how many were dropped.

#### Scenario: Dropped changes
- **WHEN** 212 changes have been recorded and the 12 oldest were dropped
- **THEN** the list begins by saying 12 older changes were dropped, and its first change row is numbered 13

### Requirement: The shown change's row names its state
The row of the change the pane shows SHALL name that change's state: Typing while it is typed, Paused while its typing is paused, Next while it waits to play, shown as it was before, and Too large when it is too large to replay. A row of any other too-large change that has played SHALL read Not typed. No other row SHALL name a state.

#### Scenario: Typing
- **WHEN** the third of five changes is being typed
- **THEN** its row reads Typing and no other row names a state

#### Scenario: Paused
- **WHEN** the user pauses while the third change is being typed
- **THEN** its row reads Paused

#### Scenario: Too large passed
- **WHEN** a 2 MB file was written, the pane said it was too large to replay, and the next change has started
- **THEN** the 2 MB file's row reads Not typed and the next change's row reads Typing

#### Scenario: Too large picked while paused
- **WHEN** playback is paused and the user presses the change that wrote a 2 MB file
- **THEN** its row reads Too large

### Requirement: Play from a picked change
Pressing a change in the list SHALL make it the next change typed: the change being typed stops, the picked change starts from its before text, and the changes recorded after it follow in recorded order. The changes recorded before it SHALL count as played. Picking a change SHALL NOT change whether playback is paused. Picking the change being typed SHALL start it over.

#### Scenario: Pick an earlier change while playing
- **WHEN** the fifth of six changes is being typed and the user presses the second change
- **THEN** the second change is typed from its before text, then the third to the sixth in order, and the first stays played

#### Scenario: Pick a later change while playing
- **WHEN** the second of six changes is being typed and the user presses the fifth
- **THEN** the fifth change is typed next and then the sixth, and the second to the fourth count as played

#### Scenario: Pick while paused
- **WHEN** playback is paused while the fifth of six changes is typed, and the user presses the second change
- **THEN** playback stays paused and nothing is typed until the user resumes, and then the second change is typed, followed by the third to the sixth

#### Scenario: Pick the change being typed
- **WHEN** the user presses the change being typed halfway through it
- **THEN** that change starts over from its before text

#### Scenario: Pick and reload
- **WHEN** playback is paused, the user presses the second of four changes, and the plugin reloads
- **THEN** playback is still paused, the second change is next, the third and fourth follow it, and the first counts as played

### Requirement: A change picked while paused is shown before it plays
When a change is picked while playback is paused, the pane SHALL name that change's file and show the file's text as it was before the change, with the change's row reading Next, until playback resumes or another change is picked. A change too large to replay SHALL instead be named as too large to replay, without its text. After a reload while playback is paused, the pane SHALL show the next change to play in the same way.

#### Scenario: Picked while paused
- **WHEN** playback is paused and the user presses a change to `src/app.ts`
- **THEN** the pane names `src/app.ts`, shows its text from before that change, and that change's row reads Next

#### Scenario: Picked new file
- **WHEN** playback is paused and the user presses a change that created `notes.md`
- **THEN** the pane names `notes.md` and shows it empty

#### Scenario: Reload while paused
- **WHEN** playback is paused with changes waiting and the plugin reloads
- **THEN** the pane names the next change's file, shows the file as it was before that change, and that change's row reads Next

#### Scenario: Picked too-large change
- **WHEN** playback is paused and the user presses the change that wrote a 2 MB file `big.json`
- **THEN** the pane says `big.json` is too large to replay and shows none of its text

### Requirement: From start
The pane SHALL have a From start control that acts as pressing the first change in the list: that change is typed next, the rest follow in recorded order, and whether playback is paused does not change.

#### Scenario: Replay after everything played
- **WHEN** every kept change has played and the user presses From start
- **THEN** the first kept change is typed again from its before text, followed by every later change in order

#### Scenario: From start while paused
- **WHEN** playback is paused and the user presses From start
- **THEN** playback stays paused, the pane shows the first kept change as it was before it, and that change's row reads Next

### Requirement: The list keeps up with playback
When more changes are kept than the pane has room to list, the list SHALL show the rows that fit and keep the row of the change the pane shows among them as playback moves on. When the person scrolls the list, it SHALL stay where they scrolled it, until they press a change in the list or press From start, Finish current or Skip to latest, after which it keeps up with playback again. Scrolling with the pointer over the code SHALL NOT move the list.

#### Scenario: Long session
- **WHEN** 80 changes are kept, the pane lists 10 rows, and change 40 starts
- **THEN** change 40's row is among the rows shown

#### Scenario: The person scrolls back
- **WHEN** the person scrolls the list up to change 3 while change 40 is typed, and change 41 then starts
- **THEN** the list still shows change 3, and change 41's row is not brought into view

#### Scenario: Picking brings it back
- **WHEN** the person has scrolled the list and presses change 5
- **THEN** change 5's row is shown, and as later changes start, their rows are shown

#### Scenario: Scrolling over the code
- **WHEN** the person scrolls with the pointer over the code while change 40 is typed, and change 41 then starts
- **THEN** the list does not move for the scroll, and change 41's row is shown

### Requirement: Finish current finishes a picked change
Finish current SHALL also finish a change picked while playback is paused: the pane shows that change's after text, playback stays paused, and the change after it plays next.

#### Scenario: Finish a picked change
- **WHEN** playback is paused, the user presses the second of four changes, and then presses Finish current
- **THEN** the pane shows the second change's after text, playback stays paused, and on resume the third change is typed

### Requirement: Playback hotkeys
While the pane holds the keyboard, the keys `r`, `p`, `f` and `l` SHALL press From start, Pause or Resume, Finish current, and Skip to latest.

#### Scenario: Hotkeys
- **WHEN** the pane holds the keyboard and the user presses `p`
- **THEN** playback pauses, as pressing Pause does

### Requirement: Numbers and tools survive a reload
A change's number in the session and the tool that made it SHALL survive a reload of the plugin within the session, along with the change.

#### Scenario: Numbers and tools
- **WHEN** Claude writes `a.ts` and then edits it, and the plugin reloads
- **THEN** the list still shows the two changes numbered 1 and 2, the first made by `Write` and the second by `Edit`

### Requirement: Changes saved without numbers or tools still load
A change saved by an earlier version of the plugin without its number or the tool that made it SHALL still survive a reload into this version. Changes saved without their numbers SHALL be numbered by their place, the last of them taking the number of changes recorded in the session, and a change saved without its tool SHALL show none.

#### Scenario: Reload across the update that numbers changes
- **WHEN** three changes, two of them played, were saved by a version that kept whether they had played but not their numbers or tools, five changes having been recorded in the session, and the plugin reloads into this version
- **THEN** the two played changes stay played, the three are numbered 3, 4 and 5, and their rows show no tool
