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

## MODIFIED Requirements

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
