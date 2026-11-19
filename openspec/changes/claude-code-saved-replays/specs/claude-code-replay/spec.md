## ADDED Requirements

### Requirement: `/typewriter` takes a word
`/typewriter` SHALL take one word after it: `save`, `load`, `list` or `delete`, each followed by what it needs. With nothing after it, `/typewriter` SHALL open the pane as before. With any other word, it SHALL answer with the words it takes and SHALL NOT open the pane. The words SHALL match ignoring case. The command SHALL show the words it takes as its hint.

#### Scenario: A word it does not take
- **WHEN** the user runs `/typewriter sav demo`
- **THEN** the answer names `save`, `load`, `list` and `delete`, and the pane does not open

#### Scenario: Bare command
- **WHEN** the user runs `/typewriter` in the desktop app
- **THEN** the pane opens, as before

#### Scenario: Any case
- **WHEN** the user runs `/typewriter LIST`
- **THEN** the saved replays are listed

### Requirement: Every word in a terminal session points to the extension
In a session that draws only on the terminal surface, `/typewriter` with any word SHALL answer with the same pointer to the VS Code extension as bare `/typewriter`, and SHALL NOT read or change saved replays.

#### Scenario: Save in a terminal session
- **WHEN** the user runs `/typewriter save demo` in a terminal session
- **THEN** the answer points to the VS Code extension, and nothing is saved

### Requirement: Save the session's changes as a named replay
`/typewriter save <name>` SHALL save every change this session recorded and still keeps, in all its own lanes, played or not, the change being typed included, in recorded order. Each SHALL keep its file, texts, kind, time, tool, number, caption, turn and agent, and the replay the prompts of the turns its changes belong to and the folder the session ran in. The answer SHALL name the replay and its change count.

#### Scenario: Save mid-session
- **WHEN** change #1 and #2 have played, #3 is being typed and #4 is queued, and the user runs `/typewriter save login fix`
- **THEN** the answer says `login fix` was saved with 4 changes, and playback goes on as it was

#### Scenario: Too large changes
- **WHEN** the session kept a change to a 2 MB generated file, and the user saves
- **THEN** the replay keeps that change as too large, with no text

#### Scenario: Nothing recorded
- **WHEN** the session has recorded no change, or every change it recorded was dropped, and the user runs `/typewriter save demo`
- **THEN** the answer says there is nothing to save, and nothing is saved

### Requirement: Save leaves out what this session did not record
A save SHALL NOT keep the changes of a loaded replay, nor where playback stands, whether it is paused, which lane is followed, or how the list is grouped.

#### Scenario: Save with a replay loaded
- **WHEN** the session recorded 3 changes and has the 5-change replay `demo` loaded, and the user runs `/typewriter save mine`
- **THEN** `mine` holds the session's 3 changes only

#### Scenario: Saved while paused
- **WHEN** the user saves while playback is paused at change #2, and later loads that replay unpaused
- **THEN** the replay plays from its first change

### Requirement: Replay names
A replay's name SHALL be what follows `save`, with whitespace runs as single spaces and no space at either end, 1 to 60 characters and no control characters. Without a name, the replay SHALL be named with the local date and time it was saved, as `YYYY-MM-DD HH:MM`. Names SHALL compare ignoring case. A name that breaks these rules SHALL be refused with an answer saying what a name may hold.

#### Scenario: No name
- **WHEN** the user runs `/typewriter save` at 14:05 on 18 November 2026
- **THEN** the replay is named `2026-11-18 14:05`

#### Scenario: Too long
- **WHEN** the user runs `/typewriter save` with a 61-character name
- **THEN** nothing is saved, and the answer says a name holds at most 60 characters

#### Scenario: Load in another case
- **WHEN** `Login Fix` is saved and the user runs `/typewriter load login fix`
- **THEN** `Login Fix` is loaded

### Requirement: Saving under a taken name replaces it
Saving under a name a saved replay already has SHALL replace that replay, keep the new name's spelling, and say in the answer that it replaced one.

#### Scenario: Save again
- **WHEN** `demo` is saved with 3 changes, and the user later runs `/typewriter save Demo` with 8 changes kept
- **THEN** one replay, `Demo`, is saved with 8 changes, and the answer says it replaced the earlier one

### Requirement: Saved replays outlast the session
Saved replays SHALL be kept in the store Claude Code keeps for the plugin, across sessions and restarts, until deleted, and SHALL be shared by every session of the plugin on that machine, sessions running at the same time included.

#### Scenario: Next session
- **WHEN** the user saves `demo`, ends the session and starts a new one
- **THEN** `/typewriter list` in the new session lists `demo`, and `/typewriter load demo` loads it

#### Scenario: Two sessions at once
- **WHEN** one session saves `a` while another session is running
- **THEN** `/typewriter list` in the other session lists `a`

### Requirement: Saved replays stay within 4 MiB
Every saved replay together SHALL take at most what the store holds, 4 MiB of JSON. A save that would pass it SHALL be refused, leaving every saved replay as it was, a replay of that name included. The answer SHALL say how much the replay takes, how much the saved replays already take of 4 MiB, and that `/typewriter delete` frees room.

#### Scenario: Store full
- **WHEN** saved replays take 3.6 MiB, and the user saves a session whose replay takes 0.9 MiB
- **THEN** nothing is saved, and the answer says the replay takes 0.9 MiB, saved replays take 3.6 MiB of 4 MiB, and `/typewriter delete <name>` frees room

#### Scenario: Replacing does not lose the old one
- **WHEN** saving `demo` again is refused for size
- **THEN** the earlier `demo` is still saved and loads as before

### Requirement: Replays keep a file's text once
A saved replay SHALL keep a file's text once, at the file's first change, and each later change to that file as the edit it made, keeping a before text again only where it differs from the file's text after the previous change. Loading SHALL rebuild every change's before and after text exactly.

#### Scenario: Many edits to one file
- **WHEN** Claude makes 40 small edits to a 300 KB file and the user saves
- **THEN** the replay takes little more than 300 KB, and once loaded each edit types exactly what it did

#### Scenario: The file changed between calls
- **WHEN** a `Bash` command changes `a.ts` between two recorded edits to it, and the user saves and later loads the replay
- **THEN** the second edit starts from the text the `Bash` command left, as it was recorded

### Requirement: List saved replays
`/typewriter list` SHALL list every saved replay, the most recently saved first, each with its name, its change count, how many files it changed, how much it takes, when it was saved, and the folder it was recorded in, then how much the saved replays take of 4 MiB. With none saved, it SHALL say so and how to save one.

#### Scenario: Two replays
- **WHEN** `demo` was saved yesterday and `login fix` today
- **THEN** the list shows `login fix` then `demo`, each with its counts, size, time and folder, and the total taken of 4 MiB

#### Scenario: None saved
- **WHEN** no replay is saved and the user runs `/typewriter list`
- **THEN** the answer says no replay is saved and names `/typewriter save <name>`

### Requirement: Delete a saved replay
`/typewriter delete <name>` SHALL remove the saved replay of that name and say so. It SHALL NOT change a lane that replay was loaded into. A name no saved replay has SHALL be answered with that, and the names that are saved.

#### Scenario: Delete
- **WHEN** the user runs `/typewriter delete demo`
- **THEN** `demo` is no longer listed, and the room it took is free

#### Scenario: Loaded and deleted
- **WHEN** `demo` is loaded and playing, and the user deletes it
- **THEN** its lane keeps playing to its end

#### Scenario: Unknown name
- **WHEN** the user runs `/typewriter delete dmeo` while `demo` is saved
- **THEN** the answer says no replay is named `dmeo` and lists `demo`

### Requirement: Load a replay into a lane of its own
`/typewriter load <name>` SHALL add the replay's changes to the pane's timeline as one lane labeled with the replay's name, in their recorded order, and follow that lane from its first change, as following a lane by hand does: a change being typed stays queued in its own lane, and whether playback is paused is kept. The lane SHALL count as finished. An unknown name SHALL be answered as `delete` answers one.

#### Scenario: Load while Main types
- **WHEN** Main is typing change #4, and the user runs `/typewriter load demo`
- **THEN** a `demo` lane appears, it is followed and its first change is typed, and Main's change #4 waits in Main

#### Scenario: Load while paused
- **WHEN** playback is paused and the user loads `demo`
- **THEN** playback stays paused, and the pane shows `demo`'s first change cued

#### Scenario: Played out
- **WHEN** the `demo` lane plays its last change while Main has two changes queued
- **THEN** Main is followed and its two changes are typed

#### Scenario: Recording goes on
- **WHEN** `demo` is playing and Claude edits a file in the main conversation
- **THEN** the change is recorded in Main and waits there

### Requirement: Loading opens the pane
Loading a replay SHALL open the pane as bare `/typewriter` does, and its answer SHALL name the replay and its change count followed by what bare `/typewriter` would answer, the pointer when the pane can't be shown included.

#### Scenario: Load in the desktop app
- **WHEN** the pane is closed and the user runs `/typewriter load demo` in the desktop app
- **THEN** the pane opens following `demo`, and the answer says `demo` was loaded with its change count and that the pane opened

#### Scenario: Load with no surface
- **WHEN** the user loads `demo` in a session no surface is attached to
- **THEN** the replay is loaded, and the answer says the pane can't be shown here and points to a local session in the desktop app or VS Code

### Requirement: Loading a loaded name replaces its lane
Loading a name whose replay is already loaded SHALL replace that lane's changes with the saved replay's, as it is saved now, and play it from its first change. Other lanes SHALL keep their changes and positions.

#### Scenario: Load twice
- **WHEN** `demo` has played halfway and the user loads `demo` again
- **THEN** the `demo` lane holds the saved replay's changes once, and plays from its first change

#### Scenario: Two replays
- **WHEN** the user loads `demo` and then `login fix`
- **THEN** each has a lane of its own, and `login fix` is followed

### Requirement: A loaded replay plays as recorded
Each loaded change SHALL type the texts it was saved with, with its number, tool, kind, caption and time. Its file SHALL be named relative to the folder the replay was recorded in. A too-large change SHALL show as too large and pass. Rows SHALL name the replay's lane, as rows of other lanes do.

#### Scenario: Recorded in another project
- **WHEN** `demo` was recorded in `/work/api` and is loaded in a session in `/work/web`
- **THEN** its change to `/work/api/src/login.ts` is named `src/login.ts`

#### Scenario: Captions
- **WHEN** a saved change had the caption "Now the limiter."
- **THEN** that caption shows over the code while it types

### Requirement: A loaded replay keeps its chapters
Grouped by turn, a loaded replay's changes SHALL sit in chapters of the replay's own turns, numbered and with the prompts as they were recorded, each header naming the replay before the turn. A subagent's change SHALL sit in the turn that started the subagent, as recorded. Grouped by file, its changes SHALL sit with the other changes to the same file.

#### Scenario: Chapters
- **WHEN** `demo` recorded changes in turns 1 and 3, and is loaded into a session in its turn 2
- **THEN** the list shows the session's chapters and `demo`'s chapters for its turns 1 and 3, each naming `demo`, with their prompts

#### Scenario: Play turn
- **WHEN** the user presses Play turn on `demo`'s turn 3 chapter
- **THEN** the `demo` lane plays from that turn's first change

### Requirement: Loaded changes are not in this conversation
A loaded change SHALL NOT offer Show in conversation: the header SHALL have no Show in conversation button while the pane shows one, and its row no ↗. No call row and no turn in the conversation SHALL get a chip for a loaded change or a loaded replay's turn.

#### Scenario: Header while a loaded change types
- **WHEN** the pane is typing `demo`'s change #2
- **THEN** the header has no Show in conversation button

#### Scenario: Rows
- **WHEN** the list shows Main's change #1 and `demo`'s change #1
- **THEN** Main's row has a ↗ and `demo`'s does not

### Requirement: Loaded changes count toward the limits
Loaded changes SHALL count toward the 200 changes and 20,000,000 characters kept, as recorded changes do, past either limit the oldest kept changes being dropped, played ones first.

#### Scenario: A long replay into a long session
- **WHEN** the session keeps 150 played changes and the user loads a 100-change replay
- **THEN** the 50 oldest played changes are dropped and all 100 loaded changes wait to play

### Requirement: Loaded replays survive a reload
A loaded replay's changes, lane, chapters and folder SHALL survive a reload of the plugin within the session, as recorded changes do. A loaded replay SHALL NOT carry over to a new session.

#### Scenario: Reload mid-replay
- **WHEN** `demo` has played 2 of its 5 changes and the plugin reloads
- **THEN** the `demo` lane keeps its 5 changes with 2 played, its chapters and its file names

#### Scenario: New session
- **WHEN** a session with `demo` loaded ends and a new one starts
- **THEN** the new session's pane has no `demo` lane until the user loads it

### Requirement: A replay that can't be read is refused
Loading a saved replay that a newer version of the plugin saved in a form this one does not read, or whose texts can't be rebuilt, SHALL load nothing, leave the pane as it was, and say why. Such a replay SHALL still be listed and deletable.

#### Scenario: Saved by a newer version
- **WHEN** a newer plugin saved `demo` in a form this version does not read, and the user loads it
- **THEN** nothing loads, and the answer says `demo` was saved by a newer version of the plugin

#### Scenario: Damaged
- **WHEN** an edit kept in `demo` reaches past the end of its file's text, and the user loads it
- **THEN** nothing loads, and the answer says `demo` can't be read and can be deleted

### Requirement: Saving writes no file
Saving and deleting a replay SHALL go only through the store Claude Code keeps for the plugin. The plugin SHALL NOT create, change or delete any file to save, list, load or delete a replay.

#### Scenario: Save
- **WHEN** the user saves `demo`
- **THEN** no file in the workspace or elsewhere is created or changed by the plugin

## MODIFIED Requirements

### Requirement: Pane opens on request or on the first change
`/typewriter` with nothing after it SHALL open the pane, except in a session that draws only on the terminal surface. When the session records its first change, the pane SHALL also open by itself where Claude Code docks a pane beside the conversation without taking it over, as in the desktop app. Elsewhere it SHALL stay undrawn until the user runs `/typewriter`.

#### Scenario: Desktop app
- **WHEN** the first change of a session in the desktop app is recorded and the pane is not open
- **THEN** the pane opens beside the conversation

#### Scenario: Command in the desktop app
- **WHEN** the user runs `/typewriter` in the desktop app while the pane is closed
- **THEN** the pane opens

#### Scenario: Later changes
- **WHEN** the user closes the pane and the session records more changes
- **THEN** the pane does not open again by itself
