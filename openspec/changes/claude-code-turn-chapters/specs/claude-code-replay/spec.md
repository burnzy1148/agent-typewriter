## ADDED Requirements

### Requirement: The changes list is grouped by turn
The list SHALL group the kept changes into one chapter per main conversation turn, each change in the chapter of the turn it belongs to. Within a chapter, changes SHALL be listed in recorded order. Chapters SHALL be ordered by their earliest kept change. A turn with no kept change SHALL have no chapter.

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
Each chapter of a turn SHALL open with a header naming the turn: `Turn` and its number, the prompt that started the turn on one line with its whitespace runs shown as single spaces and cut to fit the pane with an ellipsis, how many of its changes the pane keeps, and a Play turn button. A turn started with no prompt text SHALL show no prompt. Turns SHALL be numbered from 1 in the order the plugin saw the main conversation's turns start, counting turns that made no change.

#### Scenario: What the header shows
- **WHEN** the session's second turn began with the prompt "Cover it with tests and update the other callers." and made four kept changes
- **THEN** its chapter's header shows `Turn 2`, that prompt, `4 changes` and Play turn

#### Scenario: Long prompt
- **WHEN** a turn began with a prompt of several lines, longer than the pane is wide
- **THEN** the header shows the prompt on one line, cut with an ellipsis where the pane ends

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

### Requirement: Changes outside a known turn
Changes the plugin cannot place in a turn, because they were saved by a version that did not keep turns or were made outside any turn, SHALL be listed together in one chapter headed `Outside a turn`, with their count and a Play from first button that acts as Play turn does. A turn the plugin knows by id only, with no number or prompt, SHALL have a chapter headed `Earlier turn`, with its count and Play turn.

#### Scenario: Changes saved before turns were kept
- **WHEN** two changes were saved by a version that kept no turns, and the plugin reloads into this version
- **THEN** the list shows them in a chapter headed `Outside a turn`, with `2 changes` and Play from first

#### Scenario: Turn known by id only
- **WHEN** a change was recorded with its turn by a version that did not keep turn numbers or prompts, and the plugin reloads into this version
- **THEN** that change's chapter is headed `Earlier turn`, with its count and Play turn

### Requirement: Play turn
Pressing a chapter's Play turn SHALL act as pressing the chapter's first change in the list: that change is typed next from its before text, the changes recorded after it follow in recorded order, the changes recorded before it count as played, and whether playback is paused does not change.

#### Scenario: Replay a turn
- **WHEN** every change has played and the user presses Play turn on turn 2's chapter, whose first change is change 6
- **THEN** change 6 is typed from its before text, followed by every later change in recorded order

#### Scenario: Play turn while paused
- **WHEN** playback is paused and the user presses Play turn on turn 1's chapter
- **THEN** playback stays paused, the pane shows turn 1's first change as it was before it, and that change's row reads Next

#### Scenario: A turn whose first changes were dropped
- **WHEN** turn 1 made changes 1 to 5, changes 1 to 3 were dropped to stay within the limits, and the user presses Play turn on turn 1's chapter
- **THEN** change 4 is typed next

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
Each turn's number and prompt, and whether it has ended, SHALL survive a reload of the plugin within the session for every turn that still has a kept change, and the turns after a reload SHALL be numbered on from the last number given. A turn that was running when the plugin reloaded SHALL count as ended when the next main conversation turn starts.

#### Scenario: Reload
- **WHEN** turns 1 and 2 made changes, and the plugin reloads
- **THEN** the list still shows `Turn 1` and `Turn 2` with their prompts, and the next turn is `Turn 3`

#### Scenario: Reload during a turn
- **WHEN** the plugin reloads while turn 2 runs, and turn 3 later starts
- **THEN** turn 2's Play turn chip shows once turn 3 has started

## MODIFIED Requirements

### Requirement: Pane lists the session's changes
Below the code and the playback controls, the pane SHALL list every change the plugin keeps, grouped into chapters by turn. Each row SHALL show whether its change has played, is being typed, or waits; its number, counting the session's recorded changes from 1 in recorded order; the tool that made it, `Edit` or `Write`; its path, named as the pane names a file; and the lines it adds and removes. A row's number SHALL NOT change for the rest of the session.

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
When older changes have been dropped to stay within the limits on kept changes, the list SHALL begin by saying how many were dropped, above its first chapter.

#### Scenario: Dropped changes
- **WHEN** 212 changes have been recorded and the 12 oldest were dropped
- **THEN** the list begins by saying 12 older changes were dropped, and its first change row is numbered 13

### Requirement: The list keeps up with playback
When more changes are kept than the pane has room to list, the list SHALL show the rows that fit and keep the row of the change the pane shows among them as playback moves on. When the person scrolls the list, it SHALL stay where they scrolled it, until they press a change in the list or its chip in the conversation, press Play turn or a Play turn chip, or press From start, Finish current or Skip to latest, after which it keeps up with playback again. Scrolling with the pointer over the code SHALL NOT move the list.

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

#### Scenario: Scrolling over the code
- **WHEN** the person scrolls with the pointer over the code while change 40 is typed, and change 41 then starts
- **THEN** the list does not move for the scroll, and change 41's row is shown
