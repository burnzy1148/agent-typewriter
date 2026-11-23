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
Recorded changes SHALL be played one at a time, the followed lane's in the order they were recorded. When a change finishes, the followed lane's next recorded change SHALL start without user action unless playback is paused.

#### Scenario: Two files edited in turn
- **WHEN** Claude edits `a.ts` and then `b.ts`
- **THEN** the change to `a.ts` is typed first and the change to `b.ts` starts when it finishes

#### Scenario: Another lane's change in between
- **WHEN** Main edits `a.ts`, a subagent edits `x.ts`, and Main edits `b.ts`, while Main is followed
- **THEN** the change to `b.ts` starts when the change to `a.ts` finishes, and the change to `x.ts` stays queued in the subagent's lane

### Requirement: Playback reproduces the after text
Playback SHALL type each change from its before text by deleting and typing text in steps, and when the change finishes the text shown SHALL equal the change's after text exactly.

#### Scenario: Modified line
- **WHEN** a change replaces `return a + b;` with `return a + b + c;`
- **THEN** the pane shows the line being edited in steps, and ends showing the after text

### Requirement: Long deletions are removed at once
As in the VS Code extension, a deletion of at most 24 characters within one line SHALL be backspaced in steps, and a longer deletion, or one that spans lines, SHALL be removed in one step, after the beat in which its lines are drawn removed.

#### Scenario: Deleted function
- **WHEN** a change deletes a 200-line function
- **THEN** the function is drawn removed for a beat, then removed from the file in one step, staying in view marked removed when it was in the baseline, and typing carries on with the next edit

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
The plugin SHALL show an "Agent Typewriter" pane on the desktop and VS Code surfaces of Claude Code. While a change plays, the pane SHALL show its file, the part of its text around the caret with the caret marked, drawn as a diff against the file's baseline, and line numbers, with syntax highlighting chosen from the file's name, unless a tab is pinned.

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
The pane SHALL name the playing file by its path relative to the session's working directory, or by its absolute path when it is outside that directory, and beside the name SHALL show the number of the change it shows. When nothing is playing, the pane SHALL keep naming the last change's file and, unless a tab is pinned, showing its after text, except while playback is paused with a change cued to play next, after a pick or a reload, which it shows as it was before that change.

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
The pane SHALL show whether playback is typing, paused, or idle, and how many of the followed lane's changes are waiting to play, and while other lanes have changes waiting, how many in all. Before any change is recorded, it SHALL say that edits Claude makes will be typed out there.

#### Scenario: Changes waiting
- **WHEN** a change is playing and two more are recorded in its lane
- **THEN** the pane shows that it is typing and that 2 changes are queued

#### Scenario: Changes waiting in other lanes
- **WHEN** Main is typing with one change queued, and two subagents have three changes queued between them
- **THEN** the pane shows that it is typing, 1 queued, and 3 queued in other lanes

### Requirement: Playback controls
The pane SHALL have controls to pause and resume playback, to finish the current change at once, and to skip to the latest change. Pausing SHALL stop typing at the current keystroke, and resuming SHALL continue from there. Skipping to the latest SHALL finish every recorded change in every lane at once, keep the followed lane, and show the followed lane's last change's after text.

#### Scenario: Pause and resume
- **WHEN** the user pauses halfway through a change and later resumes
- **THEN** typing stops, and on resume continues from where it stopped

#### Scenario: Finish current
- **WHEN** the user finishes the current change while two more are queued in its lane
- **THEN** the pane shows the current change's after text and the next change starts

#### Scenario: Skip to latest
- **WHEN** the user skips to the latest while three changes are queued
- **THEN** no change is left queued and the pane shows the last recorded change's after text

#### Scenario: Skip to latest with several lanes
- **WHEN** Main is followed with two changes queued, a subagent's lane has three queued, and the user skips to the latest
- **THEN** no change is left queued in either lane, Main is still followed, and the pane shows Main's last change's after text

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
Below the code and the playback controls, the pane SHALL list every change the plugin keeps, grouped by turn or by file, as the person chose. Each row SHALL show whether its change has played, is being typed, or waits; its number, counting the session's recorded changes from 1 in recorded order; the tool that made it, `Edit` or `Write`; its path, named as the pane names a file; and the lines it adds and removes. A row's number SHALL NOT change for the rest of the session.

#### Scenario: Played, playing and queued
- **WHEN** Claude has made five changes, two have played, the third is being typed and two wait
- **THEN** the list shows five rows numbered 1 to 5, the first two marked played, the third marked as being typed, and the last two marked queued

#### Scenario: What a row shows
- **WHEN** the session runs in `/w` and Claude edits `/w/src/routes/login.ts` with `Edit`, adding one line and removing one
- **THEN** that change's row shows `Edit`, `src/routes/login.ts` and `+1 −1`

#### Scenario: Numbers stay
- **WHEN** the user plays from an earlier change, switches grouping, or the plugin reloads
- **THEN** every row keeps the number it had

#### Scenario: Same row in either grouping
- **WHEN** the user switches from By turn to By file
- **THEN** each change's row shows the same state, number, tool, path and lines as before, under its file's group

#### Scenario: Nothing recorded yet
- **WHEN** no change has been recorded
- **THEN** the pane shows no list and no grouping buttons, and says that edits Claude makes will be typed out there

### Requirement: The list says how many changes were dropped
When older changes have been dropped to stay within the limits on kept changes, the list SHALL begin by saying how many were dropped, above its first chapter or file group.

#### Scenario: Dropped changes
- **WHEN** 212 changes have been recorded and the 12 oldest were dropped
- **THEN** the list begins by saying 12 older changes were dropped, and its first change row is numbered 13

#### Scenario: Dropped changes, by file
- **WHEN** 12 older changes were dropped and the list is grouped by file
- **THEN** the list begins by saying 12 older changes were dropped, above its first file group

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
Pressing a change in the list SHALL follow its lane and make it the next change typed: the change being typed stops, the picked change starts from its before text, and the changes recorded after it in its lane follow in recorded order. The changes recorded before it in its lane SHALL count as played. Other lanes SHALL keep their positions. Picking a change SHALL NOT change whether playback is paused. Picking the change being typed SHALL start it over.

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

#### Scenario: Pick a change in another lane
- **WHEN** Main is followed and typing its change #9, and the user presses #6, which `write tests` made and has played
- **THEN** `write tests` is followed and #6 is typed from its before text, then the changes after it in `write tests`, and #9 stays queued in Main

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
The pane SHALL have a From start control that moves every lane back to its first kept change, which waits to play, and follows the lane of the first kept change: that change is typed next, the rest of its lane follow in recorded order, and whether playback is paused does not change.

#### Scenario: Replay after everything played
- **WHEN** every kept change has played and the user presses From start
- **THEN** the first kept change is typed again from its before text, followed by every later change in order

#### Scenario: From start while paused
- **WHEN** playback is paused and the user presses From start
- **THEN** playback stays paused, the pane shows the first kept change as it was before it, and that change's row reads Next

#### Scenario: From start with several lanes
- **WHEN** Main made changes 1 to 5 and 9, `write tests` made change 6, every change has played, `write tests` is followed, and the user presses From start
- **THEN** Main is followed and changes 1 to 5 and 9 are typed in order, and change 6 waits in `write tests`

### Requirement: The list keeps up with playback
When more changes are kept than the pane can list, the list SHALL show the rows that fit and keep the shown change's row among them as playback moves on. A list the person scrolled SHALL stay where they put it until they press a change in the list or its chip in the conversation, Play turn or its chip, Play from first, By turn or By file, a lane's chip, or From start, Finish current or Skip to latest; then it keeps up again. Scrolling with the pointer over the code SHALL NOT move the list.

#### Scenario: Long session
- **WHEN** 80 changes are kept, the pane lists 10 rows, and change 40 starts
- **THEN** change 40's row is among the rows shown

#### Scenario: The person scrolls back
- **WHEN** the person scrolls the list up to change 3 while change 40 is typed, and change 41 then starts
- **THEN** the list still shows change 3, and change 41's row is not brought into view

#### Scenario: Picking brings it back
- **WHEN** the person has scrolled the list and presses change 5
- **THEN** change 5's row is shown, and as later changes start, their rows are shown

#### Scenario: A chip brings it back
- **WHEN** the person has scrolled the list and presses the chip on change 5's call in the conversation
- **THEN** change 5's row is shown, and as later changes start, their rows are shown

#### Scenario: Play turn brings it back
- **WHEN** the person has scrolled the list and presses Play turn on a chapter whose first change is change 5
- **THEN** change 5's row is shown, and as later changes start, their rows are shown

#### Scenario: Play from first brings it back
- **WHEN** the person has scrolled the list grouped by file and presses Play from first on a group whose first change is change 5
- **THEN** change 5's row is shown, and as later changes start, their rows are shown

#### Scenario: Switching brings it back
- **WHEN** the person has scrolled the list while change 40 is typed, and switches grouping
- **THEN** change 40's row is shown in the new grouping, and as later changes start, their rows are shown

#### Scenario: A lane's chip brings it back
- **WHEN** the person has scrolled the list and presses the chip of the `write tests` lane, whose next change is change 7
- **THEN** change 7's row is shown, and as later changes start, their rows are shown

#### Scenario: Scrolling over the code
- **WHEN** the person scrolls with the pointer over the code while change 40 is typed, and change 41 then starts
- **THEN** the list does not move for the scroll, and change 41's row is shown

### Requirement: Finish current finishes a picked change
Finish current SHALL also finish a change picked while playback is paused: the pane shows that change's after text, playback stays paused, and the change after it in its lane plays next.

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

### Requirement: Each change knows its turn and agent
For each change it records, the plugin SHALL keep the id of the tool call that made it, the turn that call ran in, and the agent whose loop made it, with no agent for the main conversation. For a subagent's change it SHALL also keep the main conversation's turn that started the agent, and the `Agent` call that started it, following a nested agent up to the agent the main conversation started.

#### Scenario: A change in the main conversation
- **WHEN** Claude edits `a.ts` in the main conversation, in the turn the user's prompt started
- **THEN** the change keeps that call's id and that turn, and no agent

#### Scenario: A subagent's change
- **WHEN** in a turn of the main conversation Claude starts a subagent with an `Agent` call, and the subagent edits `b.ts`
- **THEN** the change keeps the edit call's id, the subagent's own turn, the subagent, the main conversation's turn that started it, and that `Agent` call

#### Scenario: An agent started by a subagent
- **WHEN** a subagent starts another agent, and that agent edits `c.ts`
- **THEN** the change keeps the main conversation's turn and the `Agent` call that started the first subagent

### Requirement: Turns and agents survive a reload
A change's call, turn, agent, main conversation turn and `Agent` call SHALL survive a reload of the plugin within the session, along with the change.

#### Scenario: Reload
- **WHEN** a subagent edits `b.ts`, and the plugin reloads
- **THEN** the change still keeps its call, turn, agent, main conversation turn and `Agent` call, and Show in conversation and the chip still work for it

### Requirement: Changes saved without turns still load
A change saved by an earlier version of the plugin, which kept its number and tool but not its turn or agent, SHALL still survive a reload into this version, with no turn, agent, main conversation turn or `Agent` call.

#### Scenario: Reload across the update that keeps turns
- **WHEN** two changes, one of them played, were saved by a version that kept numbers and tools but not turns, and the plugin reloads into this version
- **THEN** both changes load with their numbers, tools and played state, and Show in conversation still scrolls to each call

### Requirement: Show in conversation from the pane
While the pane shows a change, its header SHALL have a Show in conversation button. Each row of the changes list SHALL have a ↗ button beside it. Pressing either SHALL scroll the conversation to the `Edit` or `Write` call that made that change, and SHALL NOT change playback.

#### Scenario: From the header
- **WHEN** the pane is typing change #3 and the user presses Show in conversation
- **THEN** the conversation scrolls to the call that made change #3, and typing goes on

#### Scenario: From a row
- **WHEN** the user presses the ↗ beside change #1's row while change #3 is typing
- **THEN** the conversation scrolls to the call that made change #1, and change #3 goes on typing

#### Scenario: Nothing shown
- **WHEN** no change has been recorded
- **THEN** the pane has no Show in conversation button

### Requirement: Show in conversation falls back to the Agent call
When the call that made a change is not in the conversation, Show in conversation SHALL scroll instead to the call in the main conversation that started the agent at the top of the change's chain, an `Agent` or `Workflow` call. When it cannot scroll to either, the pane SHALL say that it could not scroll the conversation to the call, until the user next presses something in the pane.

#### Scenario: A subagent's change
- **WHEN** the conversation does not show a subagent's own calls, and the user presses the ↗ beside a change that subagent made
- **THEN** the conversation scrolls to the `Agent` call that started the subagent

#### Scenario: An agent started by a subagent
- **WHEN** the conversation shows neither the calls of an agent that a subagent started nor the subagent's own calls, and the user presses the ↗ beside a change the inner agent made
- **THEN** the conversation scrolls to the `Agent` call in the main conversation that started the subagent

#### Scenario: The scroll fails
- **WHEN** the call that made a main conversation change is no longer in the conversation, and the user presses its ↗
- **THEN** the pane says that it could not scroll the conversation to that call, and playback does not change

#### Scenario: The note clears on the next press
- **WHEN** the pane says it could not scroll, and the user then presses Finish current with nothing left to finish
- **THEN** the pane no longer says it

### Requirement: A chip on the call's row
In the conversation, the row of each `Edit` or `Write` call whose change the plugin keeps SHALL keep the engine's own drawing and add a chip naming the change's state and number: Replay when it has played, Typing or Paused when it is being typed, Next when the pane shows it cued, Queued when it waits, Too large when it is the pane's current change and too large to replay, and Not typed when it is too large and has passed.

#### Scenario: States
- **WHEN** change #1 has played, change #2 is being typed and change #3 waits
- **THEN** the rows of their calls show Replay #1, Typing #2 and Queued #3

#### Scenario: Paused and next
- **WHEN** playback is paused while typing change #2, and later the user picks change #1 while paused
- **THEN** change #2's call row shows Paused #2, and after the pick change #1's shows Next #1

#### Scenario: Too large
- **WHEN** change #4 is too large to replay, first while the pane shows it and then after it has passed
- **THEN** its call row shows Too large #4, then Not typed #4

#### Scenario: Calls with no kept change
- **WHEN** an `Edit` call failed, or its change was dropped to stay within the limits, or the call is a `Bash` call
- **THEN** its row is drawn as the engine draws it, with no chip

#### Scenario: Not on the terminal
- **WHEN** the conversation is drawn on the terminal
- **THEN** no call row has a chip

### Requirement: Pressing the chip plays from its change
Pressing a call row's chip SHALL play from that change, as pressing its row in the changes list does, and SHALL open the pane when it is not open.

#### Scenario: Replay from the conversation
- **WHEN** everything has played and the pane is closed, and the user presses Replay #2 on a call row
- **THEN** the pane opens and types change #2, then the changes after it

#### Scenario: While paused
- **WHEN** playback is paused and the user presses Queued #5 on a call row
- **THEN** the pane shows change #5 cued as it was before, and the chip reads Next #5 until playback resumes

### Requirement: `/typewriter` says when the pane can't be shown
`/typewriter` SHALL answer "Agent Typewriter pane opened." only when Claude Code places the pane. When no surface is attached to the session, the answer SHALL say the pane can't be shown in this session and name a local session in the Claude Code desktop app or in VS Code as where it can. Any other reason the pane is not placed SHALL get the same pointer with Claude Code's reason in it. The pane stays open, so a surface that attaches later draws it.

#### Scenario: Command in a cloud session
- **WHEN** the user runs `/typewriter` in a session that no surface is attached to, such as a cloud session
- **THEN** the answer says the pane can't be shown here and points to a local session in the desktop app or VS Code, and does not say the pane opened

#### Scenario: Command in the desktop app
- **WHEN** the user runs `/typewriter` in a local desktop app session and the pane is placed
- **THEN** the answer is "Agent Typewriter pane opened."

#### Scenario: Placed nowhere for another reason
- **WHEN** the user runs `/typewriter` and Claude Code leaves the pane unplaced for a reason other than having no surface
- **THEN** the answer includes that reason and the pointer, and does not say the pane opened

### Requirement: The first change says when no surface can show the pane
When the session records its first change and no surface is attached to the session, the plugin SHALL add one notice to the transcript that says the pane can't be shown in this session and names a local session in the Claude Code desktop app or in VS Code as where it can. The notice SHALL NOT be sent to the model. When the pane is left unplaced for any other reason, the plugin SHALL add no notice. Recording SHALL continue either way.

#### Scenario: First change in a cloud session
- **WHEN** Claude edits a file in a session that no surface is attached to, and it is the session's first recorded change
- **THEN** the transcript gets one notice pointing to a local session in the desktop app or VS Code, and the change is recorded

#### Scenario: Later changes in a cloud session
- **WHEN** Claude edits more files in that session
- **THEN** no further notice is added

#### Scenario: Unasked pane below the width floor
- **WHEN** the first change is recorded and Claude Code leaves the pane unplaced because the window is too narrow for a pane nobody asked for
- **THEN** no notice is added and the pane waits for `/typewriter`

### Requirement: The changes list is grouped by turn
While By turn is chosen, the list SHALL group the kept changes into one chapter per main conversation turn, each change in the chapter of the turn it belongs to. Within a chapter, changes SHALL be listed in recorded order. Chapters SHALL be ordered by their earliest kept change. A turn with no kept change SHALL have no chapter.

#### Scenario: Two turns
- **WHEN** the user's first prompt leads Claude to make changes 1 to 5, and the second prompt leads to changes 6 to 9
- **THEN** the list shows a chapter for the first turn holding changes 1 to 5, then a chapter for the second holding changes 6 to 9

#### Scenario: A turn with no changes
- **WHEN** the user asks a question that Claude answers without editing, between two turns that make changes
- **THEN** the list shows chapters only for the two turns that made changes

#### Scenario: Interleaved turns
- **WHEN** a background subagent started in turn 1 records change 7 after turn 2 recorded change 6
- **THEN** change 7 is listed in turn 1's chapter, after turn 1's earlier changes, and turn 2's chapter still follows turn 1's

### Requirement: A chapter's header
Each turn's chapter SHALL open with a header: `Turn` and its number, the prompt that started the turn on one line, whitespace runs as single spaces, kept to 200 characters, cut with an ellipsis where longer or where the pane ends, how many of its changes the pane keeps, and a Play turn button. A turn started with no prompt text SHALL show no prompt. Turns SHALL be numbered from 1 in the order the plugin saw the main conversation's turns start, counting turns that made no change.

#### Scenario: What the header shows
- **WHEN** the session's second turn began with the prompt "Cover it with tests and update the other callers." and made four kept changes
- **THEN** its chapter's header shows `Turn 2`, that prompt, `4 changes` and Play turn

#### Scenario: Long prompt
- **WHEN** a turn began with a prompt of several lines, longer than the pane is wide
- **THEN** the header shows the prompt on one line, cut with an ellipsis where the pane ends

#### Scenario: Prompt over 200 characters on a wide pane
- **WHEN** a turn began with a prompt of 500 characters, on one line, and the pane has room for more than 200 of them
- **THEN** the header shows the prompt's first 199 characters followed by an ellipsis

#### Scenario: One change
- **WHEN** a turn made one kept change
- **THEN** its header says `1 change`

### Requirement: A subagent's changes sit in the turn that started it
A change made by a subagent SHALL go in the chapter of the main conversation's turn whose `Agent` or `Workflow` call started the agent at the top of the change's chain, wherever that change falls in recorded order.

#### Scenario: Subagent in a turn
- **WHEN** in turn 2 Claude starts a subagent, and the subagent writes `test/limiter.test.ts`
- **THEN** that change is listed in turn 2's chapter

#### Scenario: Agent started by a subagent
- **WHEN** in turn 3 a subagent starts another agent, and that agent edits `c.ts`
- **THEN** the change to `c.ts` is listed in turn 3's chapter

#### Scenario: Background agent from a turn with no changes of its own
- **WHEN** in turn 1 Claude starts a background subagent and makes no change itself, turn 2 starts and makes a change, and the subagent then writes `c.ts`
- **THEN** the change to `c.ts` is listed in a chapter headed `Turn 1` with turn 1's prompt, after turn 2's chapter

### Requirement: Changes outside a known turn
Changes the plugin cannot place in a turn, because they were saved by a version that did not keep turns or were made outside any turn, SHALL be listed together in one chapter headed `Outside a turn`, with their count and a Play from first button that acts as Play turn does. A turn the plugin knows by id only, with no number or prompt, SHALL have a chapter headed `Earlier turn`, with its count and Play turn.

#### Scenario: Changes saved before turns were kept
- **WHEN** two changes were saved by a version that kept no turns, and the plugin reloads into this version
- **THEN** the list shows them in a chapter headed `Outside a turn`, with `2 changes` and Play from first

#### Scenario: Turn known by id only
- **WHEN** a change was recorded with its turn by a version that did not keep turn numbers or prompts, and the plugin reloads into this version
- **THEN** that change's chapter is headed `Earlier turn`, with its count and Play turn

### Requirement: Play turn
Pressing a chapter's Play turn SHALL move every lane that has a change in the chapter to its first change there, which is typed when its lane plays next, with the changes recorded before it in its lane counting as played and those after it following in recorded order. It SHALL follow the lane of the chapter's first change, so that change is typed next from its before text. Lanes with no change in the chapter SHALL keep their positions. Whether playback is paused SHALL NOT change.

#### Scenario: Replay a turn
- **WHEN** every change has played and the user presses Play turn on turn 2's chapter, whose first change is change 6
- **THEN** change 6 is typed from its before text, followed by every later change in recorded order

#### Scenario: Play turn while paused
- **WHEN** playback is paused and the user presses Play turn on turn 1's chapter
- **THEN** playback stays paused, the pane shows turn 1's first change as it was before it, and that change's row reads Next

#### Scenario: A turn whose first changes were dropped
- **WHEN** turn 1 made changes 1 to 5, changes 1 to 3 were dropped to stay within the limits, and the user presses Play turn on turn 1's chapter
- **THEN** change 4 is typed next

#### Scenario: A turn with subagents
- **WHEN** every change has played, and turn 2's chapter holds change 6 from `write tests`, changes 7 and 8 from `update callers` and change 9 from Main, and the user presses its Play turn
- **THEN** `write tests` is followed and change 6 is typed, and changes 7 and 8 wait in `update callers` and change 9 in Main

### Requirement: A Play turn chip in the conversation
Once a main conversation turn with kept changes has ended, the conversation SHALL show a chip reading `Play turn ·` and the turn's kept change count on the last row in the main conversation that belongs to the turn's changes: the row of the turn's last kept change's `Edit` or `Write` call, or for a subagent's change the `Agent` or `Workflow` call that started its chain. The engine's own drawing of the row SHALL be kept, along with any chip of that call's change.

#### Scenario: Turn made in the main conversation
- **WHEN** turn 1 made changes 1 to 5 in the main conversation and has ended
- **THEN** the row of change 5's call shows its own chip and `Play turn · 5 changes`

#### Scenario: Turn ending with a subagent's changes
- **WHEN** turn 2's last kept change was made by a subagent that its `Agent` call started, and turn 2 has ended
- **THEN** the row of that `Agent` call shows `Play turn ·` with turn 2's kept change count

#### Scenario: Turn still running
- **WHEN** turn 3 has made two changes and is still running
- **THEN** no row shows a Play turn chip for turn 3

#### Scenario: Not on the terminal
- **WHEN** the conversation is drawn on the terminal
- **THEN** no row has a Play turn chip

### Requirement: Pressing the Play turn chip plays the turn
Pressing a Play turn chip in the conversation SHALL act as pressing Play turn on that turn's chapter, and SHALL open the pane when it is not open.

#### Scenario: Pressing the chip
- **WHEN** the pane is closed and the user presses `Play turn · 5 changes` for turn 1
- **THEN** the pane opens and types turn 1's first kept change, then the changes after it

#### Scenario: Pressing the chip while paused
- **WHEN** playback is paused and the user presses the Play turn chip for turn 2
- **THEN** playback stays paused and turn 2's first kept change's row reads Next

### Requirement: Turns survive a reload
Each turn's number and prompt, and whether it has ended, SHALL survive a reload of the plugin within the session for every turn that still has a kept change or started an agent the plugin still knows, and the turns after a reload SHALL be numbered on from the last number given. A turn that was running when the plugin reloaded SHALL count as ended when the next main conversation turn starts.

#### Scenario: Reload
- **WHEN** turns 1 and 2 made changes, and the plugin reloads
- **THEN** the list still shows `Turn 1` and `Turn 2` with their prompts, and the next turn is `Turn 3`

#### Scenario: Reload during a turn
- **WHEN** the plugin reloads while turn 2 runs, and turn 3 later starts
- **THEN** turn 2's Play turn chip shows once turn 3 has started

### Requirement: Each change keeps the agent's words before its call
For each change it records, the plugin SHALL keep as its caption the visible text the agent wrote in the same response before the `Edit` or `Write` call, after any earlier tool call in that response. A call with no text of its own that directly follows another call in the same response SHALL share that call's caption. Thinking SHALL NOT be a caption, and text from an earlier response SHALL NOT carry over. A change with no such text SHALL have no caption.

#### Scenario: Text before the call
- **WHEN** Claude writes "Now I'll guard the login route." and then calls `Edit` on `login.ts` in the same response
- **THEN** that change's caption is "Now I'll guard the login route."

#### Scenario: Text between two calls
- **WHEN** in one response Claude writes "Add the limiter.", calls `Write` on `limiter.ts`, writes "Export it.", and calls `Edit` on `index.ts`
- **THEN** the `limiter.ts` change's caption is "Add the limiter." and the `index.ts` change's caption is "Export it."

#### Scenario: Calls made together
- **WHEN** in one response Claude writes "Update both callers." and then calls `Edit` on `signup.ts` and `Edit` on `login.ts` with no text between them
- **THEN** both changes have the caption "Update both callers."

#### Scenario: Text before another tool
- **WHEN** Claude writes "Let me read the file.", calls `Read`, and in its next response calls `Edit` with no text before it
- **THEN** the change has no caption

#### Scenario: Another tool in between, then text
- **WHEN** in one response Claude writes "Checking first.", calls `Grep`, writes "Fix the typo.", and calls `Edit`
- **THEN** the change's caption is "Fix the typo."

#### Scenario: Thinking only
- **WHEN** Claude thinks and then calls `Edit` without writing visible text
- **THEN** the change has no caption

### Requirement: Captions come from the loop that made the change
The plugin SHALL take a change's caption only from the loop whose call made it: the main conversation's text for a main conversation change, and a subagent's or teammate's own text for that agent's change. Text written in one loop SHALL NOT become the caption of a change made in another, including while several loops run at once.

#### Scenario: Two subagents at once
- **WHEN** two subagents run at the same time, one writes "Covering the refill." before it calls `Write` on `limiter.test.ts`, and the other writes "Signup gets the same guard." before it calls `Edit` on `signup.ts`
- **THEN** the `limiter.test.ts` change's caption is "Covering the refill." and the `signup.ts` change's caption is "Signup gets the same guard."

#### Scenario: Main conversation text before an agent
- **WHEN** Claude writes "I'll hand the tests to a subagent." and calls `Agent`, and the subagent calls `Write` with no text of its own before it
- **THEN** the subagent's change has no caption

### Requirement: Captions are kept as the conversation keeps the text
A caption SHALL be the text as the conversation keeps it, after any rewrite another plugin makes, with runs of whitespace and line breaks shown as single spaces and control characters shown as visible symbols. Reading the agent's text SHALL NOT change any row of the conversation, and a failure while reading it SHALL NOT affect the conversation or the recording of the change, which then has no caption.

#### Scenario: Several paragraphs
- **WHEN** Claude writes two paragraphs before an `Edit` call
- **THEN** the change's caption is both paragraphs joined by a single space

#### Scenario: Rewritten text
- **WHEN** another plugin rewrites a token in Claude's text to `***` before the conversation keeps it, and Claude then calls `Edit`
- **THEN** the caption shows `***`, as the conversation does

#### Scenario: The conversation is untouched
- **WHEN** Claude writes text and calls `Edit`
- **THEN** the conversation keeps that text and that call exactly as it would without the plugin

### Requirement: The caption shows over the code
While the pane shows a change that has a caption, it SHALL show the caption in quotes between the pane's header and the code, set apart from the code, cut with an ellipsis to fit at most three lines of the pane's width. The code SHALL give up the rows the caption takes. While the pane shows a change with no caption, or no change, it SHALL draw no caption.

#### Scenario: Typing a change with a caption
- **WHEN** the pane types a change whose caption is "Export it from the auth index."
- **THEN** “Export it from the auth index.” shows between the header and the code while it types

#### Scenario: The caption follows the shown change
- **WHEN** the change with that caption finishes and the next change, with no caption, starts typing
- **THEN** the pane draws no caption and the code takes its rows back

#### Scenario: Paused, picked or done
- **WHEN** playback is paused on a change, a picked change waits while paused, or the last change has finished
- **THEN** the pane shows the caption of the change it shows

#### Scenario: A long caption
- **WHEN** the shown change's caption needs more than three lines at the pane's width
- **THEN** the pane shows its first three lines, the last ending in an ellipsis

#### Scenario: A too-large change
- **WHEN** the pane shows a change too large to type, and it has a caption
- **THEN** the caption shows above the note that the file is too large to replay

### Requirement: A row's hover card shows its caption
On a surface with a pointer, resting the pointer on a change's row in the changes list SHALL show a card with that change's caption, cut with an ellipsis to fit the card, over the rows near it without moving them. Moving the pointer off the row SHALL hide the card. A row whose change has no caption SHALL show no card, and showing a card SHALL NOT change playback.

#### Scenario: Hovering a played change
- **WHEN** change #4 has played, its caption is "Trust the proxy so the limiter sees client addresses.", and the user rests the pointer on its row
- **THEN** a card shows that caption above the row, and playback goes on as it was

#### Scenario: A row without a caption
- **WHEN** the user rests the pointer on the row of a change with no caption
- **THEN** no card shows

#### Scenario: The rows stay put
- **WHEN** a card shows
- **THEN** no row of the list moves, and pressing a row still plays from it

### Requirement: Captions survive a reload
A change's caption SHALL survive a reload of the plugin within the session, along with the change. Changes saved by an earlier version of the plugin, which kept no captions, SHALL still load, with no caption.

#### Scenario: Reload
- **WHEN** a change with a caption has been recorded and the plugin reloads
- **THEN** the change keeps its caption, in the pane and in its row's card

#### Scenario: Reload across the update that keeps captions
- **WHEN** two changes were saved by a version that kept no captions, and the plugin reloads into this version
- **THEN** both changes load with their numbers, tools, turns and played state, and neither has a caption

### Requirement: The list can be grouped by turn or by file
The `Changes` line above the list SHALL offer two buttons, By turn and By file, with the chosen grouping drawn as the selected one. By turn SHALL be chosen until the person picks By file. Pressing a button SHALL group the list that way at once. The grouping SHALL NOT change what plays, in what order, or whether playback is paused.

#### Scenario: By turn at first
- **WHEN** Claude has made its first change of the session
- **THEN** the `Changes` line shows By turn selected and By file not, and the list is grouped by turn

#### Scenario: Switch to By file
- **WHEN** the list is grouped by turn and the user presses By file
- **THEN** By file shows selected, the list is grouped by file, and the change being typed goes on being typed

#### Scenario: Switch back
- **WHEN** the list is grouped by file and the user presses By turn
- **THEN** the list is grouped by turn again

### Requirement: The changes list is grouped by file
While By file is chosen, the list SHALL group the kept changes into one group per file they changed. Two Windows paths that differ only in `\` or `/` or in letter case SHALL count as one file; any other paths SHALL count as one file only when spelled the same. Within a group, changes SHALL be listed in recorded order. Groups SHALL be ordered by their earliest kept change, so the file whose first kept change was recorded last is listed last. A file with no kept change SHALL have no group.

#### Scenario: Three files
- **WHEN** Claude edits `src/a.ts` (change 1), `src/b.ts` (change 2), `src/a.ts` again (change 3) and then writes `test/a.test.ts` (change 4), and the list is grouped by file
- **THEN** the list shows a group for `src/a.ts` holding changes 1 and 3, then one for `src/b.ts` holding change 2, then one for `test/a.test.ts` holding change 4

#### Scenario: A file changed again later
- **WHEN** the list is grouped by file, `src/a.ts` and `src/b.ts` have groups, and Claude edits `src/a.ts` again
- **THEN** the new change is listed last in the `src/a.ts` group, which stays above the `src/b.ts` group

#### Scenario: Changes from every lane and turn
- **WHEN** in turn 1 Claude edits `src/limiter.ts`, and in turn 2 a subagent edits `src/limiter.ts` again
- **THEN** both changes are listed in the one `src/limiter.ts` group, in recorded order

#### Scenario: Same name in two folders
- **WHEN** Claude edits `src/index.ts` and `test/index.ts`, and the list is grouped by file
- **THEN** the list shows two groups, one per path

#### Scenario: Two spellings of one Windows file
- **WHEN** Claude edits `C:\w\src\a.ts` and later `c:/w/src/A.ts`, and the list is grouped by file
- **THEN** both changes are listed in one group, headed as the first change named the file

#### Scenario: Letter case elsewhere
- **WHEN** Claude edits `/w/README.md` and `/w/readme.md`, and the list is grouped by file
- **THEN** the list shows two groups

### Requirement: A file group's header
Each file group SHALL open with a header: the file name in bold, its folder named as the pane names a file and dim, how many of the file's changes the pane keeps, and a Play from first button. When the header does not fit the pane, the folder SHALL be cut first, with an ellipsis.

#### Scenario: What the header shows
- **WHEN** the session runs in `/w`, the list is grouped by file, and the pane keeps two changes to `/w/src/routes/signup.ts`
- **THEN** that group's header shows `signup.ts` in bold, `src/routes/` dim, `2 changes` and Play from first

#### Scenario: One change
- **WHEN** the pane keeps one change to a file
- **THEN** its group's header says `1 change`

#### Scenario: File outside the session folder
- **WHEN** the session runs in `/w` and Claude edits `/etc/hosts`
- **THEN** that group's header shows `hosts` and the folder `/etc/`

#### Scenario: Long folder
- **WHEN** a file's folder is longer than the room the pane leaves in its header
- **THEN** the header shows the file name, count and Play from first in full, and the folder cut with an ellipsis

### Requirement: Play from first
Pressing a file group's Play from first SHALL act as pressing the group's first change in the list: that change's lane is followed, that change is typed next from its before text, every change recorded after it in its lane follows in recorded order whatever file it changed, the changes recorded before it in its lane count as played, other lanes keep their positions, and whether playback is paused does not change.

#### Scenario: Replay a file's first change
- **WHEN** every change has played, the `src/a.ts` group holds changes 1 and 3, and the user presses its Play from first
- **THEN** change 1 is typed from its before text, followed by changes 2, 3 and every later change in recorded order

#### Scenario: Play from first while paused
- **WHEN** playback is paused and the user presses Play from first on the `src/b.ts` group, whose first change is change 2
- **THEN** playback stays paused, the pane shows `src/b.ts` as it was before change 2, and that change's row reads Next

#### Scenario: A file whose first changes were dropped
- **WHEN** changes 1 to 3 edited `src/a.ts`, changes 1 and 2 were dropped to stay within the limits, and the user presses Play from first on the `src/a.ts` group
- **THEN** change 3 is typed next

#### Scenario: A file first changed in another lane
- **WHEN** Main is followed, and the user presses Play from first on the `test/limiter.test.ts` group, whose first change `write tests` made
- **THEN** `write tests` is followed and that change is typed next, and Main's changes wait where they were

### Requirement: The chosen grouping survives a reload
The grouping the person chose SHALL survive a reload of the plugin within the session.

#### Scenario: Reload while grouped by file
- **WHEN** the user picks By file and the plugin reloads
- **THEN** the list is grouped by file and By file shows selected

### Requirement: File tabs over the code view
Over the code view the pane SHALL show a tab for each file the followed lane has typed, in the order the lane first typed them. A file has a tab while the lane keeps a change to it that has played or that the pane shows. Each tab SHALL name its file, with enough of its folder to tell apart files of the same name. The tab of the file the code view shows SHALL be marked. Following another lane SHALL show that lane's tabs.

#### Scenario: Two files typed
- **WHEN** a change to `src/a.ts` has played and a change to `src/b.ts` is being typed
- **THEN** the pane shows tabs `a.ts` and `b.ts`, in that order, with `b.ts` marked

#### Scenario: Waiting changes have no tab
- **WHEN** a change to `a.ts` is being typed and a change to `c.ts` waits
- **THEN** the pane shows a tab for `a.ts` and none for `c.ts`

#### Scenario: Same name in two folders
- **WHEN** changes to `src/index.ts` and `test/index.ts` have played
- **THEN** their tabs read `src/index.ts` and `test/index.ts`

#### Scenario: Seek back
- **WHEN** one change to `a.ts` and then one to `b.ts` have played, and the user picks the change to `a.ts`
- **THEN** the pane shows a tab for `a.ts` and none for `b.ts`

#### Scenario: Another lane's tabs
- **WHEN** Main has played changes to `a.ts`, `write tests` has played a change to `limiter.test.ts`, and the person follows `write tests`
- **THEN** the pane shows a tab for `limiter.test.ts` and none for `a.ts`

### Requirement: Tabs fit in two rows
The tabs SHALL take at most two rows. When they do not fit, the pane SHALL leave out the tabs of the files the lane typed longest ago, never the tab of the file the code view shows, and SHALL say how many tabs it left out.

#### Scenario: Many files
- **WHEN** the lane has typed 30 files and their tabs need four rows
- **THEN** the pane shows the tabs of the most recently typed files in two rows, the shown file's among them, and says how many it left out

### Requirement: Pressing a tab pins its file
Pressing the tab of a file other than the one playback shows SHALL pin it: the code view SHALL show that file as the lane last typed it, with its marks, around where it was last typed, and without a caret. Above the code, a line SHALL say which file is viewed and which file playback is in, with a Follow playback button. Playback SHALL carry on while a file is pinned.

#### Scenario: Pin a file
- **WHEN** a change to `a.ts` has played, a change to `b.ts` is being typed, and the user presses the `a.ts` tab
- **THEN** the code view shows `a.ts` as that change left it, the line says playback is in `b.ts`, and typing into `b.ts` goes on

#### Scenario: Pinned while more changes play
- **WHEN** `a.ts` is pinned and the change to `b.ts` finishes and a second change to `b.ts` starts
- **THEN** the code view still shows `a.ts`

### Requirement: A pin ends when the person returns to playback
A pin SHALL end, and the code view follow playback again, when the person presses Follow playback, presses the tab of the file playback shows, or presses anything that moves playback: a change in the list, its chip in the conversation, From start, Finish current or Skip to latest. A pin SHALL also end when its file loses its tab or playback moves into its file. Pause and Resume SHALL NOT end a pin. A pin SHALL NOT survive a reload. The header and caption SHALL stay playback's.

#### Scenario: Follow playback
- **WHEN** `a.ts` is pinned while `b.ts` is typed, and the user presses Follow playback
- **THEN** the code view shows `b.ts` with the caret where typing is

#### Scenario: Picking a change
- **WHEN** `a.ts` is pinned and the user presses a change to `c.ts` in the list
- **THEN** the pin ends and the code view shows `c.ts`

#### Scenario: Playback reaches the pinned file
- **WHEN** `a.ts` is pinned while `b.ts` is typed, and the next change to play is to `a.ts`
- **THEN** the pin ends, and the code view shows `a.ts` being typed with the caret

#### Scenario: Header and caption while pinned
- **WHEN** `a.ts` is pinned while a change to `b.ts` with the caption "Add the helper." is typed
- **THEN** the header names `b.ts` and its number, and “Add the helper.” shows above the tabs

#### Scenario: Pause keeps the pin
- **WHEN** `a.ts` is pinned and the user presses Pause
- **THEN** the code view still shows `a.ts`

### Requirement: The code view is a unified diff
The code view SHALL draw the file as a unified diff of its baseline and its shown text, with line numbers and syntax highlighting. Lines that hold text typed since the baseline SHALL be marked added, and lines of the baseline that are gone SHALL stay in view, marked removed, where they were. Marks SHALL be whole lines: a line with any change shows its baseline version removed and its new version added. The surface SHALL choose the marks' colors.

#### Scenario: Function added
- **WHEN** a played change inserts a five-line function into `a.ts`
- **THEN** the five lines are marked added and the lines around them are not marked

#### Scenario: Word changed
- **WHEN** a played change renames `foo` to `bar` on line 10 of `a.ts`
- **THEN** the old line 10 shows marked removed, followed by the new line 10 marked added

#### Scenario: Lines removed
- **WHEN** a played change removes lines 20 to 24 of `a.ts`
- **THEN** the five lines stay in view where they were, marked removed, and the line after them is numbered 20

#### Scenario: Typing a line
- **WHEN** a new line is being typed into `a.ts`
- **THEN** the line is marked added before it is finished, with the caret in it

### Requirement: Marks compare against each file's baseline
A file's baseline SHALL be its text when marks were last cleared, or, when they were not cleared, the before text of the followed lane's earliest kept change to it. Text added and later removed, or removed and later restored, SHALL leave no mark. When the oldest change to a file is dropped, its baseline SHALL become the before text of its earliest remaining change.

#### Scenario: Several changes to one file
- **WHEN** three played changes each add a different line to `a.ts`
- **THEN** all three lines are marked added

#### Scenario: Added then removed
- **WHEN** one played change adds a line to `a.ts` and a later played change removes it
- **THEN** that line shows no mark

#### Scenario: Created file
- **WHEN** a change that creates `b.ts` has played
- **THEN** every line of `b.ts` is marked added

#### Scenario: Oldest change dropped
- **WHEN** the limit drops the oldest change to `a.ts`
- **THEN** lines that change added are no longer marked

### Requirement: Marks follow the playback position
A file's marks SHALL reflect only the changes the lane has played and the part of the change being typed that is typed so far. A change cued to play next SHALL show its file's marks as they were before it. Seeking back SHALL drop the marks of changes that wait again. Skip to latest SHALL mark every change it skipped.

#### Scenario: Seek back
- **WHEN** four changes to `a.ts` have played and the user picks the third
- **THEN** the code view marks only what the first two changes did

#### Scenario: Skip to latest
- **WHEN** three changes to `a.ts` wait and the user presses Skip to latest
- **THEN** the code view marks what all three changes did

### Requirement: Lines are shown red before a deletion removes them
Before a deletion that is removed in one step, the code view SHALL draw each line the deletion touches marked removed for 400 ms, then remove the deletion. Pausing during that beat SHALL hold it, and Finish current or a seek SHALL skip it. A line of the baseline SHALL stay marked removed after the deletion; a line typed since the baseline SHALL disappear. A deletion that is backspaced SHALL get no beat.

#### Scenario: Deleted baseline block
- **WHEN** a change deletes a 20-line function that was in `a.ts`'s baseline
- **THEN** the 20 lines are drawn marked removed for 400 ms, the deletion lands, and the lines stay in view marked removed

#### Scenario: Deleting lines typed earlier
- **WHEN** one played change added three lines to `a.ts` and the next change deletes them in one step
- **THEN** the three lines are drawn marked removed for 400 ms and then disappear, leaving no mark

#### Scenario: Paused on the beat
- **WHEN** the user pauses while lines are drawn marked removed before a deletion
- **THEN** they stay drawn that way until the user resumes, and then the deletion lands

### Requirement: Clear marks
The pane SHALL have a Clear marks control. Pressing it SHALL make each file's text as the followed lane last typed it the file's baseline, so the code view shows no marks until more changes play. The clear SHALL belong to the followed lane; other lanes keep their marks. A file that a change is being typed into at the press SHALL show no marks until that change finishes, and its after text SHALL then be the file's baseline. Clear marks SHALL NOT change playback.

#### Scenario: Clear, then play more
- **WHEN** `a.ts` and `b.ts` have marks, the user presses Clear marks, and a change to `a.ts` then plays
- **THEN** `b.ts` shows no marks, and `a.ts` marks only what that change did

#### Scenario: Clear while typing
- **WHEN** the user presses Clear marks while a change to `a.ts` is being typed
- **THEN** `a.ts` shows no marks for the rest of that change, and the next change to `a.ts` is marked against the text it left

#### Scenario: Other files clear at once
- **WHEN** `b.ts` has marks and the user presses Clear marks while a change to `a.ts` is being typed
- **THEN** `b.ts` shows no marks at once, before that change finishes

#### Scenario: Another lane keeps its marks
- **WHEN** Main has played a change to `a.ts` and `write tests` a change to `b.ts`, the user presses Clear marks while Main is followed, and then follows `write tests`
- **THEN** `b.ts` still shows its marks, and following Main again shows `a.ts` with none

### Requirement: Seeking back past a clear undoes it
When a seek moves a lane's playback to a change before the one that was next in that lane when marks were cleared, that lane's clear SHALL be undone, so the changes played again are marked against the baseline from before it. A change being typed at the press counts as played for this. Moving playback in one lane SHALL NOT undo another lane's clears.

#### Scenario: Pick before the clear
- **WHEN** three changes to `a.ts` have played, the user presses Clear marks, and then picks the second change
- **THEN** once the second change plays, the code view marks what the first and second changes did

#### Scenario: A pick in another lane keeps the clear
- **WHEN** Main has played change 1, `write tests` has played change 2, the user presses Clear marks while Main is followed, and then picks change 2
- **THEN** Main's clear stays, and following Main again shows its files with no marks

### Requirement: Clears survive a reload
The clears in effect SHALL survive a reload of the plugin within a session, each with its lane, so a reload SHALL NOT bring back marks the person cleared. Clears saved by an earlier version, which kept no lanes, SHALL load as the main conversation's.

#### Scenario: Reload after a clear
- **WHEN** the user presses Clear marks after changes to `a.ts` have played, and the plugin reloads
- **THEN** `a.ts` shows no marks

#### Scenario: Clears saved before lanes
- **WHEN** an earlier version saved a clear after changes to `a.ts` played in the main conversation, and the plugin reloads into this version
- **THEN** `a.ts` shows no marks while Main is followed

### Requirement: A lane per loop
The main conversation SHALL have one lane, and each subagent whose loop makes a kept change SHALL have a lane of its own, an agent started by a subagent included. Every kept change SHALL belong to exactly one lane, the lane of the loop that made it. Each lane SHALL keep its own playback position. All lanes SHALL share the limits on kept changes. A lane SHALL exist while it has a kept change.

#### Scenario: A subagent edits beside the main conversation
- **WHEN** Claude edits `src/routes/login.ts` in the main conversation and a subagent it started writes `test/limiter.test.ts`
- **THEN** the change to `login.ts` is in the main conversation's lane and the change to `limiter.test.ts` is in the subagent's lane

#### Scenario: Two subagents
- **WHEN** Claude starts two subagents, and each edits a file
- **THEN** each change is in the lane of the subagent that made it, and there are three lanes once the main conversation has made a change too

#### Scenario: An agent started by a subagent
- **WHEN** a subagent starts another agent, and that agent edits `c.ts`
- **THEN** the change to `c.ts` is in a lane of the inner agent's own, not the subagent's

#### Scenario: Every change of a lane dropped
- **WHEN** every change a subagent made is dropped to stay within the limits
- **THEN** that subagent has no lane

### Requirement: Lanes are labeled from the Agent call
The main conversation's lane SHALL be labeled `Main`. A subagent's lane SHALL be labeled with the description its `Agent` call gave, whitespace runs as single spaces. When the plugin did not see that description, the lane SHALL be labeled with the agent's type, and when it saw neither, `Subagent`.

#### Scenario: A described subagent
- **WHEN** Claude starts a `general-purpose` subagent with the description "write tests", and it edits a file
- **THEN** its lane is labeled `write tests`

#### Scenario: A subagent started before the plugin loaded
- **WHEN** a subagent the plugin never saw start edits a file
- **THEN** its lane is labeled `Subagent`

### Requirement: Five lane colors
Each lane SHALL have one of five colors. The main conversation's lane SHALL take the first color when it is free. A new lane SHALL take the color fewest lanes hold, the earliest of those. A lane SHALL keep its color for the session. With more than five lanes, colors SHALL repeat.

#### Scenario: Three lanes
- **WHEN** the main conversation and then two subagents make changes
- **THEN** the three lanes have the first three colors, in that order

#### Scenario: Six lanes
- **WHEN** six lanes hold changes
- **THEN** two of them share a color, and every lane keeps the color it got

### Requirement: One lane is followed
Exactly one lane SHALL be followed whenever a change is kept. Only the followed lane's changes SHALL be typed. Changes in other lanes SHALL stay queued in their lanes, and recording SHALL go on in every lane. The main conversation's lane SHALL be followed while it has a kept change and no other lane was followed. While the followed lane has no kept change, the lane of the next recorded change SHALL be followed at once.

#### Scenario: A subagent records while Main is followed
- **WHEN** the main conversation's lane is followed and typing, and a subagent writes three files
- **THEN** nothing from the subagent is typed while Main types, and the subagent's lane holds three queued changes

#### Scenario: A subagent's change comes first
- **WHEN** a session's first recorded change is a subagent's
- **THEN** that subagent's lane is followed and its change is typed

### Requirement: Running and finished lanes
The main conversation's lane SHALL count as running for the whole session. A subagent's lane SHALL count as running while its loop is in a turn, and as finished otherwise.

#### Scenario: A subagent ends
- **WHEN** a subagent edits two files and its loop's turn completes
- **THEN** its lane counts as finished and keeps its two changes

#### Scenario: Main between turns
- **WHEN** the main conversation's turn has ended and no prompt has started another
- **THEN** Main's lane still counts as running

### Requirement: A finished lane gives way
When the followed lane is finished, has nothing queued and nothing is being typed, a change recorded in another lane SHALL have its lane followed. When the followed lane is finished and its last queued change finishes, the running lane whose oldest queued change was recorded first SHALL be followed. This SHALL hold with auto-follow off.

#### Scenario: A finished subagent's lane plays out while Main waits
- **WHEN** auto-follow is off, a finished subagent's lane is followed, its last queued change finishes, and Main has two changes queued
- **THEN** Main is followed and its two changes are typed

#### Scenario: Main does not give way
- **WHEN** auto-follow is off, Main is followed with nothing queued, and a running subagent records two changes
- **THEN** Main stays followed and the two changes stay queued

### Requirement: Following a lane by hand
The person SHALL be able to follow any lane by pressing its chip. Following a lane SHALL stop the change being typed, which stays queued in its lane, and SHALL resume the newly followed lane at its own position, or show its last change done when it has nothing queued. Following SHALL NOT change whether playback is paused.

#### Scenario: Switch and come back
- **WHEN** the person follows the `write tests` lane while Main has two changes queued, then follows Main again
- **THEN** `write tests` plays from its first queued change, and Main later resumes with its two queued changes

#### Scenario: Switch mid-change
- **WHEN** a change in Main is being typed and the person presses the `update callers` chip
- **THEN** typing that change stops, it stays queued in Main, and the next change typed is the first queued one of `update callers`

#### Scenario: Follow a caught-up lane while paused
- **WHEN** playback is paused and the person follows a lane with nothing queued
- **THEN** playback stays paused, and the pane shows that lane's last change done

### Requirement: Following a lane moves playback
Following a lane by hand SHALL count as moving playback, as pressing a change in the list does, for everything the pane does when a press moves playback.

#### Scenario: A scrolled list comes back
- **WHEN** the person has scrolled the changes list away from the change typing, and presses another lane's chip
- **THEN** the list shows the row of the change the pane now shows, and keeps up with playback again

### Requirement: Auto-follow
The pane SHALL have an auto-follow switch, reading `Auto-follow: on` or `Auto-follow: off`, on until the person turns it off. While it is on, once the followed lane has nothing queued and nothing has been typed for 3 seconds, the pane SHALL follow the lane whose oldest queued change was recorded first. It SHALL NOT switch lanes while a change is being typed. Following a lane by hand SHALL leave the switch as it is.

#### Scenario: Tour the subagents
- **WHEN** auto-follow is on, Main is followed and caught up, and `write tests` and then `update callers` have changes queued
- **THEN** after 3 seconds `write tests` is followed and its changes are typed, and once it has played out and 3 more seconds pass, `update callers` is followed

#### Scenario: Busy followed lane
- **WHEN** auto-follow is on and the followed lane keeps getting new changes less than 3 seconds apart
- **THEN** it stays followed while the other lanes queue

#### Scenario: Pressing the switch
- **WHEN** the person presses `Auto-follow: on`
- **THEN** it reads `Auto-follow: off`, and auto-follow is off

#### Scenario: Turned off
- **WHEN** the person turns auto-follow off while Main is caught up and a subagent's lane has changes queued
- **THEN** Main stays followed and the subagent's changes stay queued

### Requirement: Lane chips over the code
While more than one lane holds a kept change, the pane SHALL show a chip per lane above the file it shows, Main's first and the others in the order of their first kept change. Each chip SHALL show its lane's color, its label cut to 24 characters with an ellipsis, and its state: typing or paused while its change is typed, with any count queued; else the count queued; else caught up. The followed lane's chip SHALL be drawn as selected, and the row SHALL end with the auto-follow switch.

#### Scenario: Three lanes
- **WHEN** Main is followed and typing a change with one more queued, `write tests` has two queued, and `update callers` has played out
- **THEN** the chips read `Main` with typing and 1 queued, drawn as selected, `write tests` with 2 queued, and `update callers` caught up, followed by `Auto-follow: on`

### Requirement: Lane chips fit in two rows
The lane chips and the switch SHALL take at most two rows. When they do not fit, the pane SHALL leave out the chips of lanes that are not followed and have nothing queued, earliest first, then other chips but the followed lane's, latest first, and SHALL say how many it left out.

#### Scenario: Too many lanes for two rows
- **WHEN** twelve lanes hold changes and their chips need three rows
- **THEN** the chips that fit in two rows are shown, the followed lane's among them, and the pane says how many it left out

### Requirement: The pane names the followed lane
While more than one lane holds a kept change, the pane's header SHALL begin with the followed lane's color and label, and for a subagent's lane its agent type in parentheses when the plugin saw it and it is not the label itself. The label and the agent type SHALL each be cut to 24 characters with an ellipsis.

#### Scenario: Following a subagent
- **WHEN** the `write tests` lane of a `general-purpose` subagent is followed and two lanes hold changes
- **THEN** the header begins with that lane's color and `write tests (general-purpose)`

#### Scenario: A lane labeled by its agent type
- **WHEN** an `Explore` subagent the plugin saw start with no description is followed and two lanes hold changes
- **THEN** the header begins with that lane's color and `Explore`, with no agent type after it

#### Scenario: A long description
- **WHEN** the followed subagent's description is 60 characters long
- **THEN** the header shows its first 23 characters and an ellipsis

### Requirement: A row names its lane
While more than one lane holds a kept change, each row of the changes list for a subagent's change SHALL show its lane's color and label. Rows of the main conversation's changes SHALL NOT name a lane.

#### Scenario: Rows of two lanes
- **WHEN** the list holds changes from Main and from `write tests`
- **THEN** each `write tests` row shows that lane's color and label, and the Main rows show no lane

### Requirement: A single lane looks as before
While only one lane holds kept changes, the pane SHALL show no lane chips and no auto-follow switch, its header SHALL name no lane, and its rows SHALL name no lane, whichever lane it is.

#### Scenario: Only the main conversation edits
- **WHEN** every kept change was made in the main conversation
- **THEN** the pane shows no chips and no lane names

#### Scenario: Only one subagent edits
- **WHEN** every kept change was made by one subagent
- **THEN** the pane shows no chips and no lane names, and that subagent's changes are typed

### Requirement: Lanes survive a reload
Each lane, its label, its color and its playback position, the followed lane, and the auto-follow switch SHALL survive a reload of the plugin within the session. A subagent started before a reload that first edits after it SHALL get the label its `Agent` call gave. A lane that was running counts as finished after a reload until its loop starts a turn again.

#### Scenario: Reload with three lanes
- **WHEN** Main has played out, `write tests` is followed with one change being typed and one queued, `update callers` has two queued, auto-follow is off, and the plugin reloads
- **THEN** the three lanes keep their labels and colors, `write tests` is still followed and types its change from the start and then the queued one, `update callers` still has two queued, and auto-follow is still off

#### Scenario: A subagent's first edit after a reload
- **WHEN** Claude starts a subagent described "update callers", the plugin reloads, and the subagent then edits a file
- **THEN** its lane is labeled `update callers`

### Requirement: Changes saved without lanes still load
Changes saved by an earlier version of the plugin, which kept each change's agent but no lanes, SHALL load into lanes by that agent, a change with no agent in the main conversation's lane. Those the earlier version counted as played SHALL stay played. The main conversation's lane SHALL be followed when it holds a change, and the auto-follow switch SHALL be on. Lanes SHALL be labeled from what the plugin still knows of their agents and colored in the order of their first change.

#### Scenario: Reload across the update that adds lanes
- **WHEN** an earlier version saved four changes, the first two played, the second and fourth made by a subagent it knew as "write tests", and the plugin reloads into this version
- **THEN** Main holds the first and third changes, the first played, `write tests` holds the second and fourth, the second played, Main is followed, and auto-follow is on

### Requirement: A band above the prompt while the pane is out of view
On the desktop surface, while the pane is closed or open but not placed, and a change is being typed or at least one recorded change waits to play in any lane, the plugin SHALL draw one row in the band directly above the prompt. It SHALL draw nothing there while the pane is placed, while nothing is typing or queued, or while a question Claude Code asks the person holds that band. The band SHALL appear or go away as soon as any of these changes, whether or not playback moves.

#### Scenario: Pane closed while typing
- **WHEN** the user closes the pane in the desktop app while a change is being typed
- **THEN** the band appears above the prompt

#### Scenario: Pane closed while paused
- **WHEN** playback is paused halfway through a change and the user closes the pane
- **THEN** the band appears above the prompt at once

#### Scenario: Pane placed again
- **WHEN** the band shows and the user runs `/typewriter`
- **THEN** the pane is placed and the band goes away

#### Scenario: Nothing left to play
- **WHEN** the band shows and the last queued change finishes typing
- **THEN** the band goes away

#### Scenario: Only another lane waits
- **WHEN** the pane is closed, auto-follow is off, Main has played out, and a subagent's lane has two changes queued
- **THEN** the band shows, saying Main is up to date and 2 changes wait in other lanes

#### Scenario: Pane open
- **WHEN** the pane is placed in the desktop app and a change is being typed
- **THEN** no band is drawn above the prompt

#### Scenario: Pane opened unplaced
- **WHEN** the session's first change is recorded and Claude Code leaves the pane unplaced because the window is too narrow for a pane nobody asked for
- **THEN** the band appears above the prompt while that change is typed

#### Scenario: Question from Claude Code
- **WHEN** the band shows and Claude Code asks the user a question in that band
- **THEN** the plugin draws nothing there until the question is answered

### Requirement: The band and the status entry share one line
The band and the status entry SHALL read the same line: `Agent Typewriter`, playback's state (`typing`, `paused`, `paused · next` for a change cued after a pick or a reload, or `up to date`), the shown change's file name and `#` with its change number, then how many of the followed lane's changes wait to play and how many wait in other lanes, as the pane's header counts them, when any do. A change too large to replay SHALL be named as such. The band SHALL cut the line to fit beside its controls.

#### Scenario: Typing with changes queued
- **WHEN** change 3, to `src/auth/limiter.ts`, is being typed and two changes wait
- **THEN** the line reads `Agent Typewriter · typing limiter.ts #3 · 2 queued`

#### Scenario: Paused mid-change
- **WHEN** playback is paused halfway through change 3, to `limiter.ts`, with nothing waiting
- **THEN** the line reads `Agent Typewriter · paused · limiter.ts #3`

#### Scenario: Cued after a pick
- **WHEN** playback is paused and the user picks change 5, to `b.ts`, in the pane
- **THEN** the line reads `Agent Typewriter · paused · next b.ts #5`, followed by how many changes wait

#### Scenario: Changes waiting in other lanes
- **WHEN** Main is typing change 1, to `app.ts`, with one change queued, and a subagent has two changes queued
- **THEN** the line reads `Agent Typewriter · typing app.ts #1 · 1 queued · 2 in other lanes`

#### Scenario: Too large
- **WHEN** change 4, to a 2 MB `bundle.js`, comes up to play
- **THEN** the line says `bundle.js #4` is too large to replay

#### Scenario: Up to date
- **WHEN** change 7, to `limiter.ts`, has finished typing and nothing waits
- **THEN** the line reads `Agent Typewriter · up to date · limiter.ts #7`

### Requirement: The band's controls
The band SHALL have three controls after its line: Pause, reading Resume while playback is paused; Skip to latest; and Open pane. Pause and Skip to latest SHALL act as the pane's controls of the same names do. Open pane SHALL open the pane as `/typewriter` does, and when Claude Code still leaves it unplaced, the plugin SHALL say why in a short notice that goes away by itself.

#### Scenario: Pause from the band
- **WHEN** the band shows while a change is typed and the user presses Pause
- **THEN** typing stops at the current keystroke and the band's control reads Resume

#### Scenario: Skip to latest from the band
- **WHEN** the band shows with three changes queued and the user presses Skip to latest
- **THEN** every recorded change is finished at once, nothing is left queued, and the band goes away

#### Scenario: Open pane
- **WHEN** the band shows and the user presses Open pane
- **THEN** the pane opens beside the conversation and the band goes away

### Requirement: Band hotkeys
While the band holds the keyboard, the keys `p`, `l` and `o` SHALL press Pause or Resume, Skip to latest, and Open pane.

#### Scenario: Hotkey
- **WHEN** the user clicks the band, then presses `o`
- **THEN** the pane opens, as pressing Open pane does

#### Scenario: Typing in the prompt
- **WHEN** the band shows and the user types `p` in the prompt
- **THEN** the letter goes into the prompt and playback does not pause

### Requirement: A status entry carries playback state
From the session's first recorded change, the plugin SHALL keep one status entry under the prompt that reads the line the band reads, whether the pane is open or not, and SHALL change it as playback moves. Before the first recorded change it SHALL keep no status entry.

#### Scenario: Before any change
- **WHEN** a session starts and Claude has not yet edited a file
- **THEN** the plugin keeps no status entry

#### Scenario: Pane open
- **WHEN** the pane is placed and change 2, to `app.ts`, is being typed with one change waiting
- **THEN** the status entry reads `Agent Typewriter · typing app.ts #2 · 1 queued`

#### Scenario: Playback catches up
- **WHEN** the last queued change finishes typing
- **THEN** the status entry says `up to date`

#### Scenario: Reload
- **WHEN** the plugin reloads with changes queued
- **THEN** the status entry reads the line for the change that starts over, with the same queued count

### Requirement: The status entry stays off the terminal
While any surface attached to the session is the terminal, the plugin SHALL keep no status entry, and SHALL remove one it kept when a terminal attaches. When the last terminal leaves, the plugin SHALL keep the status entry again.

#### Scenario: Terminal and desktop together
- **WHEN** a session draws on the terminal and the desktop app, and a change is being typed
- **THEN** the plugin keeps no status entry, and the desktop app's band shows while its pane is closed

#### Scenario: Terminal attaches
- **WHEN** a desktop session keeps a status entry and a terminal attaches to it
- **THEN** the status entry is removed
