# change-highlighting Specification

## Purpose

Marks what replay changed in each mirror document, in the style of a git diff, so a viewer can see which text was added and where text was removed without opening a separate diff.

## Requirements

### Requirement: Highlights compare against a baseline
Each file's highlights SHALL show how its mirror's text differs from that file's baseline. The baseline SHALL be the file's text when highlights were last cleared for it, or, when they were not cleared, the before text of its earliest change in the buffer. Text added and later removed, or removed and later restored, SHALL leave no mark.

#### Scenario: First change to a file
- **WHEN** a change that inserts a function into `a.ts` is played
- **THEN** the inserted lines are highlighted as added

#### Scenario: Added then removed
- **WHEN** one played change adds a line to `a.ts` and a later played change removes that same line
- **THEN** `a.ts` shows no added highlight and no removal marker for that line

#### Scenario: Changes across several plays
- **WHEN** three played changes each add a different line to `a.ts`
- **THEN** all three lines are highlighted as added

#### Scenario: Created file
- **WHEN** a change that creates `b.ts` is played
- **THEN** every line of `b.ts` is highlighted as added

#### Scenario: Oldest change leaves the buffer
- **WHEN** the history limit drops the oldest change to `a.ts` from the buffer
- **THEN** `a.ts`'s baseline becomes the before text of its earliest remaining change, and lines added by the dropped change are no longer highlighted

### Requirement: Added text is highlighted
With `agentTypewriter.highlightAdditions` on, every line holding added text SHALL get a whole-line background, a gutter bar and an overview ruler mark. On a line that also keeps baseline text, the added characters SHALL get a stronger background. A line that is entirely new SHALL get only the line background.

#### Scenario: Word changed on a line
- **WHEN** a played change renames `foo` to `bar` on line 10 of `a.ts`
- **THEN** line 10 has the added-line background, a gutter bar and an overview ruler mark
- **AND** only the characters `bar` have the stronger added-text background

#### Scenario: New lines
- **WHEN** a played change inserts five new lines
- **THEN** each of the five lines has the added-line background and a gutter bar, and no character on them has the stronger background

### Requirement: Highlights grow as replay types
While a change is typed, highlights SHALL follow the mirror's text as it changes, so typed text appears highlighted within a fraction of a second of being typed and stays highlighted after the change finishes.

#### Scenario: Typing a line
- **WHEN** replay is typing a new line into `a.ts`
- **THEN** the characters typed so far are highlighted as added before the line is finished

#### Scenario: Change finishes
- **WHEN** the change finishes typing
- **THEN** its added text stays highlighted, and no 700 ms flash clears it

### Requirement: Highlights follow the playback position
A file's highlights SHALL reflect only the changes played so far. Seeking back SHALL remove highlights of changes that are pending again. Skip to latest SHALL highlight every change it skipped. A mirror whose text does not yet match its played changes SHALL show no highlights until it does.

#### Scenario: Seek back
- **WHEN** changes 1 to 4 to `a.ts` have been played and the user seeks to change 3
- **THEN** once `a.ts`'s mirror shows the text after change 2, only text added by changes 1 and 2 is highlighted

#### Scenario: Skip to latest
- **WHEN** three changes to `a.ts` are queued and the user skips to latest
- **THEN** text added by all three changes is highlighted

#### Scenario: Replay all
- **WHEN** every change has been played and the user runs Replay Entire Buffer
- **THEN** highlights are removed until changes are played again, and each change's added text is highlighted as it is replayed

### Requirement: Large changes highlight only what differs
A change applied all at once because it inserts more than `agentTypewriter.maxAnimatedChars` characters SHALL be highlighted like any other change. Only text that differs from the baseline SHALL be highlighted, not the whole file.

#### Scenario: Many changes in two places
- **WHEN** played changes have rewritten the first 700 and the last 700 lines of a 4,000-line file since its baseline
- **THEN** only those 1,400 lines are highlighted as added

#### Scenario: Large paste into a long file
- **WHEN** a change inserts 8,000 characters in the middle of a 2,000-line file with `maxAnimatedChars` at 6,000
- **THEN** only the inserted lines are highlighted as added

### Requirement: Deletions are previewed before they happen
With `agentTypewriter.markDeletions` on, text that replay is about to delete SHALL be shown with a red background and a strikethrough before it disappears. This SHALL apply to text that is backspaced, to text that is selected and then deleted, and to a deleted file's whole text. It SHALL NOT add any delay to playback.

#### Scenario: Multi-line deletion
- **WHEN** replay selects three lines to delete them
- **THEN** those lines show the red background and strikethrough during the pause before they are removed

#### Scenario: Backspaced word
- **WHEN** replay backspaces a short word
- **THEN** the characters not yet backspaced show the red background and strikethrough until each is removed

#### Scenario: Turned off
- **WHEN** `markDeletions` is off and replay deletes text
- **THEN** the text is selected or backspaced with no red background or strikethrough

### Requirement: Removed text is marked
With `agentTypewriter.markDeletions` on, each place where baseline text is missing from the mirror SHALL get a gutter marker and a red overview ruler mark on the line where the text was. Hovering that line SHALL show the removed text, up to 20 lines, followed by how many lines were left out. The marker SHALL take no space in the text.

#### Scenario: Lines removed
- **WHEN** a played change removes lines 20 to 24 of `a.ts`
- **THEN** a gutter marker appears at the line now following line 19, and hovering it shows the five removed lines

#### Scenario: Long removal
- **WHEN** a played change removes 50 lines
- **THEN** the hover shows the first 20 removed lines and says 30 more lines were removed

#### Scenario: Deleted file
- **WHEN** a change that deletes `c.ts` is played
- **THEN** the empty mirror shows one removal marker at line 1, and hovering it shows the start of the deleted text

#### Scenario: Removed then restored
- **WHEN** one played change removes a line and a later played change puts the same line back in the same place
- **THEN** no removal marker is shown for it

### Requirement: Highlights never change text
Highlights, removal markers and deletion previews SHALL be decorations only. A mirror's text SHALL equal the recorded after text once a change has played, whether highlighting is on or off. They SHALL appear only on `agent-typewriter:` mirror documents, never on the user's real files.

#### Scenario: Text after playback
- **WHEN** a change with additions and removals has played with both settings on
- **THEN** the mirror's text equals the change's after text

#### Scenario: Real file open beside its mirror
- **WHEN** the real file `a.ts` is open next to its highlighted mirror
- **THEN** the real file's editor shows no highlights or markers

### Requirement: Highlights can be cleared
Clear Highlights SHALL remove every file's highlights and removal markers, making each file's current played text its new baseline. Clear Highlights in This File SHALL do the same for the active mirror's file only. Changes played afterward SHALL be highlighted against the new baseline. Clearing the buffer SHALL also clear all highlights.

#### Scenario: Clear all, then play more
- **WHEN** `a.ts` and `b.ts` have highlights, the user runs Clear Highlights, and a new change to `a.ts` plays
- **THEN** `b.ts` shows no highlights, and `a.ts` highlights only the new change's added text

#### Scenario: Clear one file
- **WHEN** `a.ts` and `b.ts` have highlights and the user runs Clear Highlights in This File with `a.ts`'s mirror active
- **THEN** `a.ts` shows no highlights and `b.ts` keeps its highlights

#### Scenario: Clear while a change is typing
- **WHEN** the user runs Clear Highlights while a change to `a.ts` is being typed
- **THEN** `a.ts`'s highlights disappear, and the rest of that change types without highlights

#### Scenario: Clear while a file is being renamed
- **WHEN** the user runs Clear Highlights in This File on `a.ts` while a change renaming it to `c.ts` is played
- **THEN** once the rename has played, `c.ts` shows no highlights

#### Scenario: Not a mirror
- **WHEN** the user runs Clear Highlights in This File while a real file is the active editor
- **THEN** nothing is cleared

### Requirement: Seeking back past a clear restores highlights
When a seek or replay moves playback to a change earlier than the one that was next when highlights were cleared, that clear SHALL be undone, so replayed changes are highlighted against the earlier baseline again.

#### Scenario: Replay all after a clear
- **WHEN** the user cleared highlights after change 5, then runs Replay Entire Buffer
- **THEN** changes 1 to 5 are highlighted as they are replayed

#### Scenario: Seek forward after a clear
- **WHEN** the user cleared highlights after change 5, then seeks to change 8
- **THEN** the clear stays in effect, and only changes from 6 on are highlighted

#### Scenario: Seek between two clears
- **WHEN** the user cleared `a.ts` after change 2, cleared all files after change 5, and then seeks to change 4
- **THEN** only the clear for all files is undone, and `a.ts` is still highlighted against its text after change 2

### Requirement: Highlighting settings
`agentTypewriter.highlightAdditions` and `agentTypewriter.markDeletions` SHALL each default to `true`, SHALL take effect without a reload, and SHALL be accepted in the repository settings file like other settings. With `highlightAdditions` off, each typed hunk SHALL flash for 700 ms as it does today.

#### Scenario: Additions turned off
- **WHEN** `highlightAdditions` is set to `false` while highlights are showing
- **THEN** the added highlights disappear, removal markers stay, and later typed hunks flash briefly instead

#### Scenario: Set in the repository settings file
- **WHEN** the repository settings file sets `markDeletions` to `false`
- **THEN** no deletion previews or removal markers are shown

#### Scenario: Turned back on
- **WHEN** `highlightAdditions` is turned off and then on again
- **THEN** the highlights for every played change since the baseline reappear

### Requirement: Highlight colors are themeable and subdued
Highlight backgrounds and overview ruler marks SHALL use theme colors that the extension contributes, so users and themes can override them with `workbench.colorCustomizations`. The default backgrounds SHALL be translucent and lighter than VS Code's diff editor colors, with separate defaults for dark, light and high contrast themes.

#### Scenario: User overrides a color
- **WHEN** the user sets the added-line background color in `workbench.colorCustomizations`
- **THEN** added lines use that color

#### Scenario: Default look
- **WHEN** no color is overridden
- **THEN** the added-line background is translucent green, lighter than the diff editor's inserted-line background
