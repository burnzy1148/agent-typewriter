# Spec Delta

## Purpose

Defines how the user plays, pauses, seeks, and sets the speed of replay, and what the scrubber panel shows while it does.

## ADDED Requirements

### Requirement: Scrubber panel controls
The extension SHALL provide a "Playback" panel next to the timeline view with controls to play or pause, replay from the start, finish the current change instantly, skip to the next change, skip to the latest change, seek to any recorded change, and set the playback speed. Each control SHALL behave the same as the matching command.

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

### Requirement: Seeking
Releasing the panel's slider at a recorded change SHALL move playback so that change is the next one played. Seeking SHALL NOT change whether playback is paused. Releasing the slider at its end SHALL behave like skip to latest.

#### Scenario: Seek back while playing
- **WHEN** playback is running and the user releases the slider at the second recorded change
- **THEN** the change being typed stops, and playback continues from the second change in recorded order

#### Scenario: Seek while paused
- **WHEN** playback is paused and the user releases the slider at an earlier change
- **THEN** playback stays paused, and pressing play starts from that change

#### Scenario: Seek to the end
- **WHEN** the user releases the slider at its end
- **THEN** every mirror document shows its newest recorded state and nothing is queued

### Requirement: Panel reflects playback state
The panel SHALL show the playback position within the buffer, which change is playing, how many changes are queued, whether playback is paused, and the current speed. It SHALL update as changes are recorded and played and when playback is controlled from commands or the status bar.

#### Scenario: New change recorded
- **WHEN** a watched file changes while the panel is visible
- **THEN** the slider range grows to include the new change, and the queued count goes up

#### Scenario: Paused from the status bar
- **WHEN** the user pauses by clicking the status bar item
- **THEN** the panel shows playback as paused

#### Scenario: Panel reopened
- **WHEN** the panel is hidden and shown again
- **THEN** it shows the current position, pause state, and speed

### Requirement: Title bar keeps only watching controls
The timeline view's title bar SHALL show only the start or stop watching button, with configuration and buffer actions in its overflow menu. Pause, finish current, skip to latest, and replay all SHALL remain available as commands.

#### Scenario: Title bar while watching
- **WHEN** the extension is watching
- **THEN** the timeline view's title bar shows the stop watching button and no playback buttons

### Requirement: Locked-down webview
The panel's webview MUST NOT load remote content or any local files. Only its own inline script and styles, tagged with a per-load nonce, SHALL run. Messages from the webview that are malformed or of an unknown type SHALL be ignored.

#### Scenario: Content Security Policy
- **WHEN** the panel's HTML is generated
- **THEN** its Content Security Policy sets `default-src 'none'` and allows scripts and styles only by nonce

#### Scenario: Malformed message
- **WHEN** the webview posts a seek with a non-integer position, or a speed that is not a positive number
- **THEN** the extension does nothing
