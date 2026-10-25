# Spec Delta

## MODIFIED Requirements

### Requirement: Scrubber panel controls
The extension SHALL provide a "Playback" panel in the Agent Typewriter container, next to the Changes view, with controls to play or pause, replay from the start, finish the current change instantly, skip to the next change, skip to the latest change, seek to any recorded change, and set the playback speed. Each control SHALL behave the same as the matching command. Replay from the start, skip, skip to latest and seeking SHALL act on the followed lane only. Pause and speed SHALL apply to playback as a whole.

#### Scenario: Pause and resume from the panel
- **WHEN** a change is being typed and the user presses pause in the panel
- **THEN** typing stops, and the panel and status bar both show playback as paused
- **WHEN** the user presses play
- **THEN** typing resumes where it stopped

#### Scenario: Skip to next change
- **WHEN** a change is being typed and the user presses skip to next
- **THEN** typing of that change stops, the change after it is played next, and playback stays paused or playing as it was
- **WHEN** nothing is being typed and the user presses skip to next
- **THEN** the next queued change is skipped and the one after it is played next
- **WHEN** the change skipped is the newest one in the buffer
- **THEN** it behaves like skip to latest

#### Scenario: Speed from the panel
- **WHEN** the user picks 2x in the panel's speed control
- **THEN** the manual playback speed is 2x, and catch-up acceleration still applies on top

#### Scenario: Skip to latest with two lanes
- **WHEN** `feature` is followed with three changes queued, the main lane has two queued, and the user presses skip to latest
- **THEN** `feature`'s mirrors show its newest recorded state and nothing is queued in `feature`
- **AND** the main lane still has two changes queued

### Requirement: Seeking
Releasing the panel's slider at a recorded change SHALL move playback so that change is the next one played. The slider SHALL span the followed lane's changes. Seeking SHALL NOT change whether playback is paused. Releasing the slider at its end SHALL behave like skip to latest.

#### Scenario: Seek back while playing
- **WHEN** playback is running and the user releases the slider at the second recorded change
- **THEN** the change being typed stops, and playback continues from the second change in recorded order

#### Scenario: Seek while paused
- **WHEN** playback is paused and the user releases the slider at an earlier change
- **THEN** playback stays paused, and pressing play starts from that change

#### Scenario: Seek to the end
- **WHEN** the user releases the slider at its end
- **THEN** every mirror document of the followed lane shows its newest recorded state and nothing is queued in that lane

### Requirement: Panel reflects playback state
The panel SHALL show the followed lane's label when more than one lane is in the buffer, the playback position within that lane, which change is playing, how many of its changes are queued, whether playback is paused, and the current speed. It SHALL update as changes are recorded and played, when another lane is followed, and when playback is controlled from commands or the status bar.

#### Scenario: New change recorded
- **WHEN** a watched file changes while the panel is visible
- **THEN** the slider range grows to include the new change, and the queued count goes up

#### Scenario: Paused from the status bar
- **WHEN** the user pauses by clicking the status bar item
- **THEN** the panel shows playback as paused

#### Scenario: Panel reopened
- **WHEN** the panel is hidden and shown again
- **THEN** it shows the current position, pause state, and speed

#### Scenario: Another lane followed
- **WHEN** the user follows `feature`, which has five changes, two of them queued
- **THEN** the panel shows `feature`, a slider over its five changes, and two queued
