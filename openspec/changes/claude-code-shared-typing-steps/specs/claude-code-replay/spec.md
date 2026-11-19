## MODIFIED Requirements

### Requirement: Long deletions are removed at once
As in the VS Code extension, a deletion of at most 24 characters within one line SHALL be backspaced in steps, and a longer deletion, or one that spans lines, SHALL be selected, held selected for a beat of about 380 ms divided by the playback speed, and then removed in one step.

#### Scenario: Deleted function
- **WHEN** a change deletes a 200-line function
- **THEN** the function is selected for a beat, disappears in one step, and typing carries on with the next edit

#### Scenario: Renamed identifier
- **WHEN** a change replaces `total` with `sum`
- **THEN** `total` is backspaced a few characters at a time before `sum` is typed

#### Scenario: Paused during the beat
- **WHEN** the user pauses while a long deletion is selected and resumes 5 s later
- **THEN** the deletion stays selected and in place until the user resumes, and is removed after the rest of the beat

### Requirement: Typing speed setting
The plugin SHALL provide a `charsPerMinute` option that sets the base typing speed in characters per minute, defaulting to 1000. A value that is not a number greater than zero SHALL be treated as 1000. A change to the option SHALL apply from the next keystroke. The catch-up speedup SHALL multiply the base speed.

#### Scenario: Default speed
- **WHEN** `charsPerMinute` is not set
- **THEN** changes are typed at about 1000 characters per minute while no other change waits

#### Scenario: Faster speed
- **WHEN** `charsPerMinute` is 3000 and no other change waits
- **THEN** a change that inserts 300 characters on one line takes about 6 seconds to type

## ADDED Requirements

### Requirement: Typing follows the extension's pace
The plugin SHALL type each change with the same pacing decisions as the VS Code extension under its default settings: every delay varies at random by up to 48% either way; the indent at the start of a new line goes in at once; a line break is followed by a pause of 2 to 4.4 characters' time; `;`, `{`, `}` and `,` by up to 1.5 characters' time; and about one line in 40 by a thinking pause of 0.3 to 1 s, divided by the playback speed.

#### Scenario: Indented body
- **WHEN** a change types a function body whose lines are indented by four spaces
- **THEN** each line's four spaces appear at once and the rest of the line is typed a few characters at a time

#### Scenario: Uneven rhythm
- **WHEN** a change types 200 characters across 10 lines
- **THEN** the time between keystrokes varies, and the pane lingers longer after each line break than between letters

### Requirement: A beat before each edit
When the caret reaches an edit, the plugin SHALL wait about 220 ms, varied at random and divided by the playback speed, before it deletes or types there.

#### Scenario: Two edits in a change
- **WHEN** a change edits line 3 and then line 9
- **THEN** the caret rests at line 3 briefly before typing starts there, and again at line 9 before typing starts there

### Requirement: The caret moves to each edit
Before an edit, the plugin SHALL put the caret at the end of the text it deletes when that is at most 24 characters within one line, and otherwise where the edit starts. When the caret and the edit are both within the code rows the pane last drew, and the caret can reach the edit in at most 24 arrow-key presses, the caret SHALL walk there one press at a time, at about 15 presses per second divided by the playback speed. Otherwise it SHALL be placed there at once.

#### Scenario: Edit a few lines down
- **WHEN** the caret is at the end of line 2 after an edit, and the next edit, on line 8, is in the drawn rows
- **THEN** the caret moves through each of lines 3 to 7 before it reaches line 8

#### Scenario: Edit far away
- **WHEN** the next edit is 300 lines below the caret
- **THEN** the caret is placed at the edit at once

#### Scenario: Picked while paused
- **WHEN** playback is paused and the user presses a change whose first edit deletes a 60-character line
- **THEN** the pane shows the caret where that line starts

### Requirement: Read pause before leaving typed text
Before the pane's code view leaves what was just typed, the plugin SHALL wait until at least 1.5 s, divided by the playback speed, have passed since it last changed the shown text. The view leaves when the next edit lies outside the code rows the pane last drew, other than a move within a block typed outside in, or when the next change is to another file. Time paused or waiting for the next change SHALL count toward it.

#### Scenario: Next edit off-screen
- **WHEN** a change edits line 3 and line 350 of a 400-line file, and line 350 is outside the drawn rows after the first edit
- **THEN** about 1.5 s pass between the last character typed on line 3 and the view moving to line 350

#### Scenario: Switching files
- **WHEN** a change to `b.ts` is queued right behind a change to `a.ts`
- **THEN** `a.ts` stays shown for about 1.5 s after its last character is typed, then `b.ts` is shown

#### Scenario: Next change arrives late
- **WHEN** a change to `a.ts` finishes and the next change, to `b.ts`, is recorded 10 s later
- **THEN** `b.ts` is shown without a further wait

### Requirement: No read pause after a jump in playback
The plugin SHALL NOT wait for the read pause for the first change played, or for the first change played after Play from a picked change, From start, Play turn, Skip to latest, or a reload. Text that Finish current puts in SHALL count as just typed, so a read pause still follows it.

#### Scenario: After a pick
- **WHEN** the user presses an earlier change to another file right after a change finished typing
- **THEN** that change's file is shown and typed without a read pause

#### Scenario: After Finish current
- **WHEN** the user presses Finish current on a change to `a.ts` with a change to `b.ts` queued behind it
- **THEN** `a.ts` shows its after text for about 1.5 s before `b.ts` is shown

### Requirement: File-switch delay
After the pane switches to another file's text, the plugin SHALL wait about 1 s, divided by the playback speed and at most 15 s, before the first edit there. The first change played SHALL NOT wait for it.

#### Scenario: Default delay
- **WHEN** a change to `b.ts` is queued right behind a change to `a.ts`
- **THEN** `a.ts` stays shown about 1.5 s, then `b.ts` is shown about 1 s before its first edit

#### Scenario: Same file
- **WHEN** a change to `a.ts` is queued right behind another change to `a.ts`
- **THEN** the second change starts without a file-switch delay

### Requirement: Catch-up speed
While changes wait behind the one being typed, the plugin SHALL multiply the playback speed by one plus half the number of changes waiting, at most 8. The speedup SHALL follow the count as it changes, from the next keystroke or wait.

#### Scenario: Four changes waiting
- **WHEN** a change is typed at 1000 characters per minute and four more changes are waiting
- **THEN** it is typed at about 3000 characters per minute, and its pauses are a third as long

#### Scenario: Long backlog
- **WHEN** 30 changes are waiting
- **THEN** playback runs at 8 times its base speed
