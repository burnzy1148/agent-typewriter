# Spec Delta

## Purpose

Defines what the buffer of recorded changes keeps for replay: how much change text and how many changes it holds across all lanes, which changes it drops first, and how dropping queued changes is reported.

## ADDED Requirements

### Requirement: The buffer is bounded by the size of its change text
The buffer SHALL hold at most `agentTypewriter.historySizeMB` (default 64, minimum 1) megabytes of change text across all lanes, counting each change's before and after text at one byte per character. When a new change would exceed it, the oldest changes SHALL be dropped, whichever lane they are in. The newest change SHALL always be kept, even when it alone exceeds the bound.

#### Scenario: Large files fill the buffer
- **WHEN** `historySizeMB` is 1 and four changes of about 300,000 characters each (before plus after) are recorded
- **THEN** the buffer holds the newest three, and the oldest one is no longer listed

#### Scenario: One change larger than the bound
- **WHEN** `historySizeMB` is 1 and a change with 2,000,000 characters of before and after text is recorded
- **THEN** the buffer holds that change alone

#### Scenario: Lowering the setting
- **WHEN** the buffer holds 40 MB of change text and `historySizeMB` is set to 10
- **THEN** the oldest changes are dropped at once until the rest fit in 10 MB

### Requirement: The buffer is also bounded by change count
`agentTypewriter.historyLimit` (default 500, minimum 10) SHALL stay a bound on the number of changes in the buffer across all lanes. The oldest changes SHALL be dropped until both the count bound and the size bound hold.

#### Scenario: Many small changes
- **WHEN** `historyLimit` is 10, `historySizeMB` is 64, and 12 one-line changes are recorded
- **THEN** the buffer holds the newest 10

### Requirement: Dropping queued changes is reported
When either bound drops changes that had not been played, the Changes view SHALL say how many queued changes were dropped because the buffer is full, naming both settings.

#### Scenario: Queued changes dropped
- **WHEN** playback is paused and recording fills the buffer past `historySizeMB`
- **THEN** the Changes view says queued changes were dropped because the buffer is full (`historyLimit` or `historySizeMB`)
