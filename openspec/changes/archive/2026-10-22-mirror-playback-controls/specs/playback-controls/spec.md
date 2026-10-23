# Spec Delta

## ADDED Requirements

### Requirement: Playback mirror
The playback mirror SHALL be the mirror document of the change being typed. When no change is being typed, it SHALL be the mirror document most recently played into, including by skip to latest. Before anything has been played, and after a session is loaded until one of its changes plays, there SHALL be no playback mirror. Controls on mirror tabs SHALL appear only on the playback mirror.

#### Scenario: Playback moves to another file
- **WHEN** a change to `a.ts` finishes and the next change, to `b.ts`, starts typing
- **THEN** the controls appear on the `b.ts` mirror tab and no longer on the `a.ts` mirror tab

#### Scenario: Caught up
- **WHEN** the last queued change, to `a.ts`, finishes and nothing is queued
- **THEN** the controls stay on the `a.ts` mirror tab

#### Scenario: Nothing played yet
- **WHEN** the extension has just activated and no change has been played
- **THEN** no mirror tab shows the controls

#### Scenario: Session loaded
- **WHEN** playback last played `a.ts` and the user loads a saved session
- **THEN** no mirror tab shows the controls until a change from the loaded session plays

#### Scenario: Real files untouched
- **WHEN** the real file `a.ts` is open in a tab next to its mirror
- **THEN** the real file's tab shows no playback controls

### Requirement: Mirror title bar controls
The playback mirror's editor title bar SHALL show buttons to replay all, play or pause, finish the current change instantly, skip to the next change, and skip to the latest change. Each button SHALL behave the same as the matching command. While the buffer is empty, only play or pause SHALL show, in the title bar and in the status row.

#### Scenario: Skip to latest from the title bar
- **WHEN** three changes are queued and the user presses skip to latest in the playback mirror's title bar
- **THEN** every mirror document shows its newest recorded state and nothing is queued

#### Scenario: Buffer cleared
- **WHEN** the user clears the buffer
- **THEN** the playback mirror's title bar and status row offer play or pause and no replay, finish, or skip controls

#### Scenario: Finish current from the title bar
- **WHEN** a change is being typed and the user presses finish current in the playback mirror's title bar
- **THEN** the rest of that change appears at once and playback carries on with the next change

### Requirement: Play/pause button shows its action
The title bar's play/pause button SHALL show a pause icon while playback is running and a play icon while it is paused. Pressing it SHALL pause when it shows pause and resume when it shows play, even if playback was paused or resumed elsewhere just before the press reached the extension.

#### Scenario: Paused from the status bar
- **WHEN** the user pauses by clicking the status bar item
- **THEN** the playback mirror's title bar shows the play button

#### Scenario: Press after the state changed
- **WHEN** the title bar shows pause, playback is paused from the Playback panel, and a press of the title bar's pause button arrives afterward
- **THEN** playback stays paused

### Requirement: Mirror status row
The playback mirror SHALL show a row above its first line, without changing the document's text. The row SHALL hold clickable controls to play or pause, finish current, skip to next, and skip to latest, plus the current speed and a readout of the playing or next change, the position in the buffer, and the queued count.

#### Scenario: Row while typing
- **WHEN** change #12 to `src/a.ts` is being typed, it is the 4th of 12 changes in the buffer, 3 are queued, and the speed is 2x
- **THEN** the row reads as typing `#12 src/a.ts`, position 4 of 12, 3 queued, and 2x

#### Scenario: File name with icon syntax
- **WHEN** the change being typed is to `docs/$(home)-notes.md`
- **THEN** the row's readout shows the file name as typed, not an icon

#### Scenario: Row does not touch the text
- **WHEN** a change has been played into the playback mirror with the row showing
- **THEN** the mirror's text equals the recorded after text

#### Scenario: Pick a speed from the row
- **WHEN** the user clicks the speed in the row
- **THEN** the same speed picker as the Set Speed command opens, and picking 2x sets the manual speed to 2x

#### Scenario: Readout opens the panel
- **WHEN** the user clicks the readout in the row
- **THEN** the Playback panel is revealed

### Requirement: Status row stays current
The status row SHALL update as changes are recorded and played, when playback moves to another mirror, and when playback is controlled from commands, the Playback panel, the status bar, or the title bar.

#### Scenario: New change recorded
- **WHEN** a watched file changes while the row is showing
- **THEN** the row's buffer size and queued count go up

#### Scenario: Paused from the panel
- **WHEN** the user pauses in the Playback panel
- **THEN** the row shows playback as paused and offers play

### Requirement: Status row can be turned off
The setting `agentTypewriter.mirrorStatusRow` (default `true`) SHALL control whether the status row is shown. Changing it SHALL take effect without a reload. The row SHALL NOT appear when VS Code's `editor.codeLens` setting is off. The setting SHALL be accepted in the repository settings file like other settings.

#### Scenario: Turned off while showing
- **WHEN** the row is showing and the user sets `agentTypewriter.mirrorStatusRow` to `false`
- **THEN** the row disappears and the title bar buttons remain

#### Scenario: Set in the repository settings file
- **WHEN** the repository settings file sets `mirrorStatusRow` to `false`
- **THEN** the row is not shown
