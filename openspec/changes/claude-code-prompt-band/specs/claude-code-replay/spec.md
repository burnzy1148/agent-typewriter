## ADDED Requirements

### Requirement: A band above the prompt while the pane is out of view
On the desktop surface, while the pane is closed or open but not placed, and a change is being typed or at least one recorded change waits to play, the plugin SHALL draw one row in the band directly above the prompt. It SHALL draw nothing there while the pane is placed, while nothing is typing or queued, or while a question Claude Code asks the person holds that band. The band SHALL appear or go away as soon as any of these changes, whether or not playback moves.

#### Scenario: Pane closed while typing
- **WHEN** the user closes the pane in the desktop app while a change is being typed
- **THEN** the band appears above the prompt

#### Scenario: Pane closed while paused
- **WHEN** playback is paused halfway through a change and the user closes the pane
- **THEN** the band appears above the prompt at once

#### Scenario: Pane placed again
- **WHEN** the band shows and the user runs `/typewriter`
- **THEN** the pane is placed and the band goes away

#### Scenario: Nothing left to play
- **WHEN** the band shows and the last queued change finishes typing
- **THEN** the band goes away

#### Scenario: Pane open
- **WHEN** the pane is placed in the desktop app and a change is being typed
- **THEN** no band is drawn above the prompt

#### Scenario: Pane opened unplaced
- **WHEN** the session's first change is recorded and Claude Code leaves the pane unplaced because the window is too narrow for a pane nobody asked for
- **THEN** the band appears above the prompt while that change is typed

#### Scenario: Question from Claude Code
- **WHEN** the band shows and Claude Code asks the user a question in that band
- **THEN** the plugin draws nothing there until the question is answered

### Requirement: The band and the status entry share one line
The band and the status entry SHALL read the same line: `Agent Typewriter`, playback's state (`typing`, `paused`, `paused · next` for a change cued after a pick or a reload, or `up to date`), the shown change's file name and `#` with its change number, then how many changes wait to play, as the pane counts them, when any do. A change too large to replay SHALL be named as such. The band SHALL cut the line to fit beside its controls.

#### Scenario: Typing with changes queued
- **WHEN** change 3, to `src/auth/limiter.ts`, is being typed and two changes wait
- **THEN** the line reads `Agent Typewriter · typing limiter.ts #3 · 2 queued`

#### Scenario: Paused mid-change
- **WHEN** playback is paused halfway through change 3, to `limiter.ts`, with nothing waiting
- **THEN** the line reads `Agent Typewriter · paused · limiter.ts #3`

#### Scenario: Cued after a pick
- **WHEN** playback is paused and the user picks change 5, to `b.ts`, in the pane
- **THEN** the line reads `Agent Typewriter · paused · next b.ts #5`, followed by how many changes wait

#### Scenario: Too large
- **WHEN** change 4, to a 2 MB `bundle.js`, comes up to play
- **THEN** the line says `bundle.js #4` is too large to replay

#### Scenario: Up to date
- **WHEN** change 7, to `limiter.ts`, has finished typing and nothing waits
- **THEN** the line reads `Agent Typewriter · up to date · limiter.ts #7`

### Requirement: The band's controls
The band SHALL have three controls after its line: Pause, reading Resume while playback is paused; Skip to latest; and Open pane. Pause and Skip to latest SHALL act as the pane's controls of the same names do. Open pane SHALL open the pane as `/typewriter` does, and when Claude Code still leaves it unplaced, the plugin SHALL say why in a short notice that goes away by itself.

#### Scenario: Pause from the band
- **WHEN** the band shows while a change is typed and the user presses Pause
- **THEN** typing stops at the current keystroke and the band's control reads Resume

#### Scenario: Skip to latest from the band
- **WHEN** the band shows with three changes queued and the user presses Skip to latest
- **THEN** every recorded change is finished at once, nothing is left queued, and the band goes away

#### Scenario: Open pane
- **WHEN** the band shows and the user presses Open pane
- **THEN** the pane opens beside the conversation and the band goes away

### Requirement: Band hotkeys
While the band holds the keyboard, the keys `p`, `l` and `o` SHALL press Pause or Resume, Skip to latest, and Open pane.

#### Scenario: Hotkey
- **WHEN** the user clicks the band, then presses `o`
- **THEN** the pane opens, as pressing Open pane does

#### Scenario: Typing in the prompt
- **WHEN** the band shows and the user types `p` in the prompt
- **THEN** the letter goes into the prompt and playback does not pause

### Requirement: A status entry carries playback state
From the session's first recorded change, the plugin SHALL keep one status entry under the prompt that reads the line the band reads, whether the pane is open or not, and SHALL change it as playback moves. Before the first recorded change it SHALL keep no status entry.

#### Scenario: Before any change
- **WHEN** a session starts and Claude has not yet edited a file
- **THEN** the plugin keeps no status entry

#### Scenario: Pane open
- **WHEN** the pane is placed and change 2, to `app.ts`, is being typed with one change waiting
- **THEN** the status entry reads `Agent Typewriter · typing app.ts #2 · 1 queued`

#### Scenario: Playback catches up
- **WHEN** the last queued change finishes typing
- **THEN** the status entry says `up to date`

#### Scenario: Reload
- **WHEN** the plugin reloads with changes queued
- **THEN** the status entry reads the line for the change that starts over, with the same queued count

### Requirement: The status entry stays off the terminal
While any surface attached to the session is the terminal, the plugin SHALL keep no status entry, and SHALL remove one it kept when a terminal attaches. When the last terminal leaves, the plugin SHALL keep the status entry again.

#### Scenario: Terminal and desktop together
- **WHEN** a session draws on the terminal and the desktop app, and a change is being typed
- **THEN** the plugin keeps no status entry, and the desktop app's band shows while its pane is closed

#### Scenario: Terminal attaches
- **WHEN** a desktop session keeps a status entry and a terminal attaches to it
- **THEN** the status entry is removed
