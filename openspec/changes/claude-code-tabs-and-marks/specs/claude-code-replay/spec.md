## ADDED Requirements

### Requirement: File tabs over the code view
Over the code view the pane SHALL show a tab for each file the followed lane has typed, in the order the lane first typed them. A file has a tab while the lane keeps a change to it that has played or that the pane shows. Each tab SHALL name its file, with enough of its folder to tell apart files of the same name. The tab of the file the code view shows SHALL be marked. Until the pane follows other lanes, the followed lane is the main conversation's.

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
A pin SHALL end, and the code view follow playback again, when the person presses Follow playback, presses the tab of the file playback shows, or presses anything that moves playback: a change in the list, its chip in the conversation, From start, Finish current or Skip to latest. A pin SHALL also end when its file loses its tab. Pause and Resume SHALL NOT end a pin. A pin SHALL NOT survive a reload.

#### Scenario: Follow playback
- **WHEN** `a.ts` is pinned while `b.ts` is typed, and the user presses Follow playback
- **THEN** the code view shows `b.ts` with the caret where typing is

#### Scenario: Picking a change
- **WHEN** `a.ts` is pinned and the user presses a change to `c.ts` in the list
- **THEN** the pin ends and the code view shows `c.ts`

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

#### Scenario: Deleted function
- **WHEN** a change deletes a 20-line function that was in `a.ts`'s baseline
- **THEN** the 20 lines are drawn marked removed for 400 ms, the deletion lands, and the lines stay in view marked removed

#### Scenario: Deleting lines typed earlier
- **WHEN** one played change added three lines to `a.ts` and the next change deletes them in one step
- **THEN** the three lines are drawn marked removed for 400 ms and then disappear, leaving no mark

#### Scenario: Paused on the beat
- **WHEN** the user pauses while lines are drawn marked removed before a deletion
- **THEN** they stay drawn that way until the user resumes, and then the deletion lands

### Requirement: Clear marks
The pane SHALL have a Clear marks control. Pressing it SHALL make each file's text as the followed lane last typed it the file's baseline, so the code view shows no marks until more changes play. A file that a change is being typed into at the press SHALL show no marks until that change finishes, and its after text SHALL then be the file's baseline. Clear marks SHALL NOT change playback.

#### Scenario: Clear, then play more
- **WHEN** `a.ts` and `b.ts` have marks, the user presses Clear marks, and a change to `a.ts` then plays
- **THEN** `b.ts` shows no marks, and `a.ts` marks only what that change did

#### Scenario: Clear while typing
- **WHEN** the user presses Clear marks while a change to `a.ts` is being typed
- **THEN** `a.ts` shows no marks for the rest of that change, and the next change to `a.ts` is marked against the text it left

### Requirement: Seeking back past a clear undoes it
When a seek moves playback to a change before the one that was next when marks were cleared, that clear SHALL be undone, so the changes played again are marked against the baseline from before it. A change being typed at the press counts as played for this.

#### Scenario: Pick before the clear
- **WHEN** three changes to `a.ts` have played, the user presses Clear marks, and then picks the second change
- **THEN** once the second change plays, the code view marks what the first and second changes did

### Requirement: Clears survive a reload
The clears in effect SHALL survive a reload of the plugin within a session, so a reload SHALL NOT bring back marks the person cleared.

#### Scenario: Reload after a clear
- **WHEN** the user presses Clear marks after changes to `a.ts` have played, and the plugin reloads
- **THEN** `a.ts` shows no marks
