## ADDED Requirements

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

## MODIFIED Requirements

### Requirement: Changes play in recorded order
Recorded changes SHALL be played one at a time, the followed lane's in the order they were recorded. When a change finishes, the followed lane's next recorded change SHALL start without user action unless playback is paused.

#### Scenario: Two files edited in turn
- **WHEN** Claude edits `a.ts` and then `b.ts`
- **THEN** the change to `a.ts` is typed first and the change to `b.ts` starts when it finishes

#### Scenario: Another lane's change in between
- **WHEN** Main edits `a.ts`, a subagent edits `x.ts`, and Main edits `b.ts`, while Main is followed
- **THEN** the change to `b.ts` starts when the change to `a.ts` finishes, and the change to `x.ts` stays queued in the subagent's lane

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

### Requirement: Finish current finishes a picked change
Finish current SHALL also finish a change picked while playback is paused: the pane shows that change's after text, playback stays paused, and the change after it in its lane plays next.

#### Scenario: Finish a picked change
- **WHEN** playback is paused, the user presses the second of four changes, and then presses Finish current
- **THEN** the pane shows the second change's after text, playback stays paused, and on resume the third change is typed

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

### Requirement: Clear marks
The pane SHALL have a Clear marks control. Pressing it SHALL make each file's text as the followed lane last typed it the file's baseline, so the code view shows no marks until more changes play. A clear SHALL belong to the lane followed at the press: other lanes keep their marks, and the clear applies whenever its lane is followed. A file that a change is being typed into at the press SHALL show no marks until that change finishes, and its after text SHALL then be the file's baseline. Clear marks SHALL NOT change playback.

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
