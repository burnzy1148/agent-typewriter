## ADDED Requirements

### Requirement: A scrubber under the transport on the desktop
On the desktop surface, while the plugin keeps at least one change, the pane SHALL draw a scrubber row under its playback controls. The row SHALL show the followed lane's name while more than one lane is kept, then a track with one mark per kept change of the followed lane in recorded order, then the shown change's position in that lane as `<k> of <n>`. The pane SHALL draw no scrubber on any other surface, and none before a change is recorded.

#### Scenario: One lane
- **WHEN** the main conversation has made nine kept changes, and the fourth is being typed
- **THEN** the scrubber shows nine marks and `4 of 9`, with no lane name

#### Scenario: Several lanes
- **WHEN** a subagent's lane is followed, it has three kept changes, and the main conversation has six
- **THEN** the scrubber shows the subagent lane's name, three marks, and the shown change's position among those three

#### Scenario: VS Code
- **WHEN** the pane is drawn in VS Code
- **THEN** it draws no scrubber

### Requirement: The scrubber shows each change's state
Each mark SHALL show its change's state: played, being typed or paused, cued next, queued, or too large to replay. The mark of the change the pane shows SHALL be drawn taller than the others. Played and queued marks SHALL differ in shape or lightness, not only in color.

#### Scenario: Played, typing and queued
- **WHEN** the followed lane has five changes, two have played, the third is being typed and two wait
- **THEN** the first two marks show played, the third shows typing and is taller, and the last two show queued

#### Scenario: Cued while paused
- **WHEN** playback is paused and the user presses an earlier change in the list
- **THEN** that change's mark shows cued next and is the taller one

### Requirement: A gap between turns on the scrubber
The track SHALL leave a gap between two neighbouring marks whose changes sit in different chapters of the list grouped by turn, while those gaps take at most a quarter of the track. Changes outside a known turn SHALL count as one turn.

#### Scenario: Two turns
- **WHEN** turn 1 made changes 1 to 5 and turn 2 made changes 6 to 9, all in the followed lane
- **THEN** the track shows five marks, a gap, then four marks

#### Scenario: A subagent's lane
- **WHEN** a followed subagent lane holds three changes, all made in the turn that started it
- **THEN** its three marks have no gap between them

### Requirement: The scrubber fits the pane
When the followed lane has more kept changes than the track has cells, neighbouring changes SHALL share a cell, every kept change SHALL still be reachable by dragging, and a shared cell holding the shown change SHALL show that change's state.

#### Scenario: Many changes, narrow pane
- **WHEN** the followed lane keeps 200 changes and the track is 60 cells wide
- **THEN** the track fits in its row, and dragging from one end to the other names changes from the first to the last

### Requirement: Dragging the scrubber names a change without moving playback
Pressing on the track and moving with the button held SHALL mark the change under the pointer and name it in place of the position, as `#<number> <file name>`, without changing what plays or whether playback is paused. Moving past either end of the track SHALL mark the first or last change. Resting the pointer on the track without pressing SHALL name the change under it the same way, and moving the pointer off SHALL bring the position back.

#### Scenario: Drag while typing
- **WHEN** change #9 is being typed and the user presses on the track and drags to change #3's mark
- **THEN** the scrubber names `#3` and its file, and change #9 goes on being typed

#### Scenario: Hover
- **WHEN** the user rests the pointer over change #6's mark without pressing
- **THEN** the scrubber names `#6` and its file, and playback goes on as it was

### Requirement: Releasing the scrubber plays from the change
Releasing the button SHALL act as pressing the marked change's row in the list: that change is typed next from its before text, the changes recorded after it in its lane follow, and whether playback is paused does not change. A press and release on one change SHALL act the same. Releasing more than two rows above or below the scrubber SHALL cancel: playback does not move, and the scrubber SHALL say that releasing there cancels while the pointer is that far away.

#### Scenario: Release while playing
- **WHEN** change #9 is being typed and the user drags to change #3 and releases
- **THEN** change #3 is typed from its before text, followed by the changes after it in the lane

#### Scenario: Release while paused
- **WHEN** playback is paused and the user drags to change #5 and releases
- **THEN** playback stays paused, the pane shows change #5 as it was before, and its row reads Next

#### Scenario: Click a mark
- **WHEN** the user presses and releases on change #2's mark without moving off it
- **THEN** change #2 is typed next, as if its row were pressed

#### Scenario: Cancel
- **WHEN** the user drags to change #3, moves the pointer four rows above the scrubber and releases
- **THEN** playback does not move, and the scrubber shows the position again

#### Scenario: The list follows again
- **WHEN** the person has scrolled the changes list and then releases the scrubber on change #5
- **THEN** change #5's row is shown in the list, as after pressing it

### Requirement: Keys on the scrubber and the code
While the scrubber holds the keyboard after a click, Left and Right SHALL play from the change before or after the shown one in the followed lane, as Previous and Next do. While the scrubber or the code holds the keyboard after a click, `r`, `p`, `f` and `l` SHALL press From start, Pause or Resume, Finish current and Skip to latest, as they do while the pane holds it.

#### Scenario: Right after a click
- **WHEN** the user clicks change #4's mark, and once it is typing presses Right
- **THEN** change #5 is typed next

#### Scenario: Pause from the code
- **WHEN** the user clicks in the code while a change is typed, then presses `p`
- **THEN** playback pauses

### Requirement: Typing shows character by character on the desktop
On the desktop surface, when one step of playback types several characters at the caret, the pane SHALL show them one after another over its frames instead of together, and SHALL never show the code more than one step behind playback. A deletion, a change shown at once, a pick, Finish current, Skip to latest, or a new change SHALL be shown at once. When a change finishes, the code shown SHALL be its after text exactly.

#### Scenario: Fast typing
- **WHEN** playback types twelve characters in one step on the desktop
- **THEN** the pane shows them appearing in order over several frames, all shown before the next step's text appears

#### Scenario: Finish current
- **WHEN** the user presses Finish current while characters are still appearing
- **THEN** the pane shows the change's after text at once

#### Scenario: Paused mid-reveal
- **WHEN** the user pauses while characters of the last step are still appearing
- **THEN** the remaining characters of that step appear and then nothing more is typed

### Requirement: The code window holds still on the desktop
On the desktop surface, the code SHALL keep its rows where they are while the caret stays at least two rows inside the top and bottom of the code. Showing another file, a change shown at once, or a pick SHALL show the caret's line in the middle at once.

#### Scenario: Typing within the window
- **WHEN** a change types ten lines in the middle of the code shown
- **THEN** the code's rows do not move while those lines are typed

#### Scenario: Another file
- **WHEN** the next change is to another file
- **THEN** that file is shown with the caret's line in the middle at once

### Requirement: The code window scrolls smoothly on the desktop
On the desktop surface, when the caret moves past the rows the code holds still for, the code SHALL scroll to put the caret's line in the middle, a whole row or more per frame, easing in and out. A longer move SHALL take longer, up to about one second at normal speed, and a higher playback speed SHALL shorten it in proportion.

#### Scenario: An edit further down
- **WHEN** after typing near line 20 the next edit of the change is at line 70, below the code shown
- **THEN** the code scrolls down over several frames until line 70 is in the middle

#### Scenario: Faster playback
- **WHEN** the playback speed is 2× and the same move happens
- **THEN** the scroll takes about half as long

### Requirement: Previous and Next where there is no scrubber
Wherever the pane draws no scrubber, its playback controls SHALL add Previous and Next after Skip to latest while any change is kept. Previous SHALL act as pressing the row of the change before the shown one in the followed lane, and on the lane's first change SHALL start it over. Next SHALL act as pressing the row of the change after the shown one, and on the lane's last change SHALL act as Finish current. Neither SHALL change whether playback is paused.

#### Scenario: Previous in VS Code
- **WHEN** the pane in VS Code is typing change #5 of the followed lane and the user presses Previous
- **THEN** change #4 is typed from its before text, followed by the changes after it

#### Scenario: Next while paused
- **WHEN** playback is paused on change #2 and the user presses Next
- **THEN** playback stays paused, the pane shows change #3 as it was before, and its row reads Next

#### Scenario: Next on the last change
- **WHEN** the last change of the followed lane is being typed and the user presses Next
- **THEN** the pane shows that change's after text, as Finish current does

#### Scenario: Desktop with a working scrubber
- **WHEN** the pane is drawn on the desktop and its scrubber draws
- **THEN** the controls have no Previous or Next

### Requirement: The desktop falls back when a surface module fails
When the scrubber or the smooth code view fails to load or stops on the desktop, the pane SHALL keep working: for the rest of the session it SHALL draw that part as on a surface without them, the code redrawn on each step, and Previous and Next in place of the scrubber. Playback SHALL NOT change because of the failure. A reload of the plugin SHALL try the surface modules again.

#### Scenario: The scrubber fails
- **WHEN** the scrubber's module fails on the desktop while a change is typed
- **THEN** the pane draws Previous and Next, and the change goes on being typed

#### Scenario: The code view fails
- **WHEN** the smooth code view's module fails on the desktop
- **THEN** the pane draws the code as in VS Code, and playback goes on
