# Spec Delta

## ADDED Requirements

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
When a change is picked while playback is paused, the pane SHALL name that change's file and show the file's text as it was before the change, with the change's row reading Next, until playback resumes or another change is picked. After a reload while playback is paused, the pane SHALL show the next change to play in the same way.

#### Scenario: Picked while paused
- **WHEN** playback is paused and the user presses a change to `src/app.ts`
- **THEN** the pane names `src/app.ts`, shows its text from before that change, and that change's row reads Next

#### Scenario: Picked new file
- **WHEN** playback is paused and the user presses a change that created `notes.md`
- **THEN** the pane names `notes.md` and shows it empty

#### Scenario: Reload while paused
- **WHEN** playback is paused with changes waiting and the plugin reloads
- **THEN** the pane names the next change's file, shows the file as it was before that change, and that change's row reads Next

### Requirement: From start
The pane SHALL have a From start control that acts as pressing the first change in the list: that change is typed next, the rest follow in recorded order, and whether playback is paused does not change.

#### Scenario: Replay after everything played
- **WHEN** every kept change has played and the user presses From start
- **THEN** the first kept change is typed again from its before text, followed by every later change in order

#### Scenario: From start while paused
- **WHEN** playback is paused and the user presses From start
- **THEN** playback stays paused, the pane shows the first kept change as it was before it, and that change's row reads Next

### Requirement: The list keeps up with playback
When more changes are kept than the pane has room to list, the list SHALL show the rows that fit and keep the row of the change the pane shows among them as playback moves on. When the person scrolls the list, it SHALL stay where they scrolled it, until they press a change in the list or press From start, Finish current or Skip to latest, after which it keeps up with playback again.

#### Scenario: Long session
- **WHEN** 80 changes are kept, the pane lists 10 rows, and change 40 starts
- **THEN** change 40's row is among the rows shown

#### Scenario: The person scrolls back
- **WHEN** the person scrolls the list up to change 3 while change 40 is typed, and change 41 then starts
- **THEN** the list still shows change 3, and change 41's row is not brought into view

#### Scenario: Picking brings it back
- **WHEN** the person has scrolled the list and presses change 5
- **THEN** change 5's row is shown, and as later changes start, their rows are shown

## MODIFIED Requirements

### Requirement: Playback controls
The pane SHALL have controls to replay from the start, to pause and resume playback, to finish the current change at once, and to skip to the latest change. Pausing SHALL stop typing at the current keystroke, and resuming SHALL continue from there. Finishing the current change SHALL show its after text, a change picked while paused included, and the change after it SHALL play next. Skipping to the latest SHALL finish every recorded change at once and show the last one's after text. While the pane holds the keyboard, the keys `r`, `p`, `f` and `l` SHALL press From start, Pause or Resume, Finish current, and Skip to latest.

#### Scenario: Pause and resume
- **WHEN** the user pauses halfway through a change and later resumes
- **THEN** typing stops, and on resume continues from where it stopped

#### Scenario: Finish current
- **WHEN** the user finishes the current change while two more are queued
- **THEN** the pane shows the current change's after text and the next change starts

#### Scenario: Finish a picked change
- **WHEN** playback is paused, the user presses the second of four changes, and then presses Finish current
- **THEN** the pane shows the second change's after text, playback stays paused, and on resume the third change is typed

#### Scenario: Skip to latest
- **WHEN** the user skips to the latest while three changes are queued
- **THEN** no change is left queued and the pane shows the last recorded change's after text

#### Scenario: Hotkeys
- **WHEN** the pane holds the keyboard and the user presses `p`
- **THEN** playback pauses, as pressing Pause does

### Requirement: Pane names the file
The pane SHALL name the playing file by its path relative to the session's working directory, or by its absolute path when it is outside that directory. When nothing is playing, the pane SHALL keep showing the last change's file and after text, except while a change picked while paused waits to play, which it shows as it was before that change.

#### Scenario: File in the project
- **WHEN** the session runs in `/w` and a change to `/w/src/app.ts` plays
- **THEN** the pane names it `src/app.ts`

#### Scenario: Waiting after a pick
- **WHEN** a change to `a.ts` has finished playing, playback is paused, and the user presses an earlier change to `b.ts`
- **THEN** the pane names `b.ts` and shows it as it was before that change

### Requirement: Recorded changes last for the session
Recorded changes, played or queued, SHALL survive a reload of the plugin within a session, as when an option changes, each with its texts, whether it has played, whether it created its file, when it was recorded, its number in the session, and the tool that made it. The change being typed then starts over. Changes SHALL NOT carry over to a new session. Besides the change being typed, at most 200 changes, with at most 20,000,000 characters of before and after text, SHALL be kept; past either limit, the oldest SHALL be dropped, played ones first.

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

#### Scenario: Numbers and tools
- **WHEN** Claude writes `a.ts` and then edits it, and the plugin reloads
- **THEN** the list still shows the two changes numbered 1 and 2, the first made by `Write` and the second by `Edit`

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
A change saved by an earlier version of the plugin without some of what this version keeps SHALL still survive a reload into this version. A change saved without whether it had played, its kind or its time SHALL wait to play and count as modifying its file, and its time SHALL be 0, which means the time it was recorded is unknown. Changes saved without their numbers SHALL be numbered by their place, the last of them taking the number of changes recorded in the session, and a change saved without its tool SHALL show none.

#### Scenario: Reload across an update
- **WHEN** changes were queued by a version of the plugin that saved neither their kind nor their time, and the plugin reloads into this version within the same session
- **THEN** those changes play in their recorded order, each counted as modifying its file, with time 0

#### Scenario: Reload across the update that numbers changes
- **WHEN** three changes, two of them played, were saved by a version that kept whether they had played but not their numbers or tools, five changes having been recorded in the session, and the plugin reloads into this version
- **THEN** the two played changes stay played, the three are numbered 3, 4 and 5, and their rows show no tool
