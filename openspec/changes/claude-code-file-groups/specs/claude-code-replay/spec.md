## ADDED Requirements

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
While By file is chosen, the list SHALL group the kept changes into one group per file they changed, each change in the group of its path. Within a group, changes SHALL be listed in recorded order. Groups SHALL be ordered by their earliest kept change, so the file whose first kept change was recorded last is listed last. A file with no kept change SHALL have no group.

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
Pressing a file group's Play from first SHALL act as pressing the group's first change in the list: that change is typed next from its before text, every change recorded after it follows in recorded order whatever file it changed, the changes recorded before it count as played, and whether playback is paused does not change.

#### Scenario: Replay a file's first change
- **WHEN** every change has played, the `src/a.ts` group holds changes 1 and 3, and the user presses its Play from first
- **THEN** change 1 is typed from its before text, followed by changes 2, 3 and every later change in recorded order

#### Scenario: Play from first while paused
- **WHEN** playback is paused and the user presses Play from first on the `src/b.ts` group, whose first change is change 2
- **THEN** playback stays paused, the pane shows `src/b.ts` as it was before change 2, and that change's row reads Next

#### Scenario: A file whose first changes were dropped
- **WHEN** changes 1 to 3 edited `src/a.ts`, changes 1 and 2 were dropped to stay within the limits, and the user presses Play from first on the `src/a.ts` group
- **THEN** change 3 is typed next

### Requirement: The chosen grouping survives a reload
The grouping the person chose SHALL survive a reload of the plugin within the session.

#### Scenario: Reload while grouped by file
- **WHEN** the user picks By file and the plugin reloads
- **THEN** the list is grouped by file and By file shows selected

## MODIFIED Requirements

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

### Requirement: Pane lists the session's changes
Below the code and the playback controls, the pane SHALL list every change the plugin keeps, grouped into chapters by turn or into groups by file, as the person chose. Each row SHALL show whether its change has played, is being typed, or waits; its number, counting the session's recorded changes from 1 in recorded order; the tool that made it, `Edit` or `Write`; its path, named as the pane names a file; and the lines it adds and removes. A row SHALL show the same in either grouping, and its number SHALL NOT change for the rest of the session.

#### Scenario: Played, playing and queued
- **WHEN** Claude has made five changes, two have played, the third is being typed and two wait
- **THEN** the list shows five rows numbered 1 to 5, the first two marked played, the third marked as being typed, and the last two marked queued

#### Scenario: What a row shows
- **WHEN** the session runs in `/w` and Claude edits `/w/src/routes/login.ts` with `Edit`, adding one line and removing one
- **THEN** that change's row shows `Edit`, `src/routes/login.ts` and `+1 −1`

#### Scenario: Numbers stay
- **WHEN** the user plays from an earlier change, switches grouping, or the plugin reloads
- **THEN** every row keeps the number it had

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

### Requirement: The list keeps up with playback
When more changes are kept than the pane has room to list, the list SHALL show the rows that fit and keep the row of the change the pane shows among them as playback moves on. When the person scrolls the list, it SHALL stay where they scrolled it, until they press a change in the list or its chip in the conversation, press Play turn, a Play turn chip or Play from first, switch grouping, or press From start, Finish current or Skip to latest, after which it keeps up with playback again. Scrolling with the pointer over the code SHALL NOT move the list.

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

#### Scenario: Scrolling over the code
- **WHEN** the person scrolls with the pointer over the code while change 40 is typed, and change 41 then starts
- **THEN** the list does not move for the scroll, and change 41's row is shown
