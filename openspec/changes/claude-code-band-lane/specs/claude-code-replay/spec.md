## MODIFIED Requirements

### Requirement: The band and the status entry share one line
The band and the status entry SHALL share one line: `Agent Typewriter`, the followed lane's label while more than one lane holds changes, playback's state (`typing`, `paused`, `paused · next` for a change cued after a pick or reload, or `up to date`), the shown change's file name and `#<number>`, then how many of the followed lane's changes wait and how many in other lanes, when any do. A change too large to replay SHALL be named as such. The band SHALL cut the line to fit beside its controls.

#### Scenario: Typing with changes queued
- **WHEN** change 3, to `src/auth/limiter.ts`, is being typed and two changes wait
- **THEN** the line reads `Agent Typewriter · typing limiter.ts #3 · 2 queued`

#### Scenario: Paused mid-change
- **WHEN** playback is paused halfway through change 3, to `limiter.ts`, with nothing waiting
- **THEN** the line reads `Agent Typewriter · paused · limiter.ts #3`

#### Scenario: Cued after a pick
- **WHEN** playback is paused and the user picks change 5, to `b.ts`, in the pane
- **THEN** the line reads `Agent Typewriter · paused · next b.ts #5`, followed by how many changes wait

#### Scenario: Changes waiting in other lanes
- **WHEN** Main is typing change 1, to `app.ts`, with one change queued, and a subagent has two changes queued
- **THEN** the line reads `Agent Typewriter · Main · typing app.ts #1 · 1 queued · 2 in other lanes`

#### Scenario: Following a subagent
- **WHEN** the `write tests` lane is followed and typing change 4, to `limiter.test.ts`, with nothing more queued in it, and Main has one change queued
- **THEN** the line reads `Agent Typewriter · write tests · typing limiter.test.ts #4 · 1 in other lanes`

#### Scenario: Other lanes played out
- **WHEN** a subagent's lane holds changes that have all played, and Main is typing change 6, to `app.ts`, with nothing queued
- **THEN** the line reads `Agent Typewriter · Main · typing app.ts #6`

#### Scenario: One lane
- **WHEN** every kept change was made by one subagent and its change 2, to `a.ts`, is being typed
- **THEN** the line reads `Agent Typewriter · typing a.ts #2`, naming no lane

#### Scenario: Too large
- **WHEN** change 4, to a 2 MB `bundle.js`, comes up to play
- **THEN** the line says `bundle.js #4` is too large to replay

#### Scenario: Up to date
- **WHEN** change 7, to `limiter.ts`, has finished typing and nothing waits
- **THEN** the line reads `Agent Typewriter · up to date · limiter.ts #7`

## ADDED Requirements

### Requirement: How the band and the status entry name the lane
The followed lane's label in the line SHALL be cut to 16 characters with an ellipsis, with no agent type after it. The band SHALL draw a dot in that lane's color directly before the label, as the pane's header does; the status entry SHALL carry the label without a color. While the line names no lane, the band SHALL draw no dot.

#### Scenario: A long lane label
- **WHEN** the followed subagent's description is `update every caller of the limiter` and two lanes hold changes
- **THEN** the line names the lane `update every ca…`

#### Scenario: Two lanes
- **WHEN** the pane is closed and the `write tests` lane is followed and typing while Main has changes queued
- **THEN** the band reads `Agent Typewriter ·`, a dot in the `write tests` lane's color, then `write tests · typing`, and the status entry reads the same words with no dot

#### Scenario: The followed lane changes
- **WHEN** the band shows the `write tests` lane and auto-follow moves to Main
- **THEN** the band's dot takes Main's color and its label reads `Main`

#### Scenario: One lane
- **WHEN** the pane is closed and only the main conversation has made changes
- **THEN** the band draws no dot
