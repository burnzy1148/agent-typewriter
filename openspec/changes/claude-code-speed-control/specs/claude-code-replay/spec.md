# Spec Delta

## ADDED Requirements

### Requirement: A speed control on the transport
After Skip to latest, the pane SHALL draw a Speed control offering 0.5×, 1×, 2× and 4×, showing the chosen speed. The speed SHALL be 1× until the person picks another. The chosen speed SHALL multiply the playback speed together with the catch-up speedup. A pick SHALL apply from the next keystroke and SHALL NOT change whether playback is paused or which change plays.

#### Scenario: Default speed
- **WHEN** the person has not picked a speed
- **THEN** the Speed control shows 1× and changes are typed at the speed `charsPerMinute` sets

#### Scenario: Faster
- **WHEN** `charsPerMinute` is 1000, nothing is queued, and the person picks 2×
- **THEN** the change being typed goes on at 2000 characters per minute from the next keystroke

#### Scenario: On top of catch-up
- **WHEN** the speed is 2× and two changes are queued behind the one being typed, so catch-up multiplies the speed by 2
- **THEN** typing runs at 4 times the speed `charsPerMinute` sets

#### Scenario: Picking while paused
- **WHEN** playback is paused mid-change and the person picks 4×
- **THEN** playback stays paused, and on resume the change goes on from where it stopped at 4×

### Requirement: The speed applies to every wait
The chosen speed SHALL divide every wait playback makes, the pause between one change and the next included, by the same factor that multiplies the typing speed.

#### Scenario: Pause between changes at 2×
- **WHEN** the speed is 2× and a change finishes with another queued
- **THEN** the next change starts after half the pause it gets at 1×

#### Scenario: Pause between changes at 0.5×
- **WHEN** the speed is 0.5× and a change finishes with another queued
- **THEN** the next change starts after twice the pause it gets at 1×

### Requirement: The chosen speed survives a reload
The chosen speed SHALL survive a reload of the plugin within the session.

#### Scenario: Reload at 4×
- **WHEN** the person picks 4× and the plugin reloads
- **THEN** the Speed control shows 4× and playback goes on at 4×

### Requirement: A catching-up chip
While a change is being typed, playback is not paused, and the followed lane has three or more changes queued behind it, the transport SHALL end with a chip reading `catching up <n>×`, where `<n>` is the catch-up speedup in effect (requirement *Catch-up speed*), shown with at most one decimal and no trailing `.0`. Otherwise the pane SHALL show no such chip.

#### Scenario: Three queued
- **WHEN** a change is being typed with three changes queued behind it
- **THEN** the transport ends with `catching up 2.5×`

#### Scenario: Two queued
- **WHEN** a change is being typed with two changes queued behind it
- **THEN** the pane shows no catching-up chip

#### Scenario: Paused
- **WHEN** playback is paused with five changes queued
- **THEN** the pane shows no catching-up chip

#### Scenario: Capped
- **WHEN** a change is being typed with 20 changes queued
- **THEN** the transport ends with `catching up 8×`

### Requirement: A surface without a Select draws no speed control
On a surface whose elements include no Select, the pane SHALL draw the rest of the transport and no speed control, and the chosen speed SHALL still apply.

#### Scenario: Surface without a Select
- **WHEN** the pane is drawn on a surface that carries no Select and the speed chosen elsewhere is 2×
- **THEN** the transport shows From start, Pause, Finish current and Skip to latest, no Speed control, and typing runs at 2×
