# Spec Delta

## ADDED Requirements

### Requirement: Each change knows its turn and agent
For each change it records, the plugin SHALL keep the id of the tool call that made it, the turn that call ran in, and the agent whose loop made it, with no agent for the main conversation. For a subagent's change it SHALL also keep the main conversation's turn that started the agent, and the `Agent` call that started it, following a nested agent up to the agent the main conversation started.

#### Scenario: A change in the main conversation
- **WHEN** Claude edits `a.ts` in the main conversation, in the turn the user's prompt started
- **THEN** the change keeps that call's id and that turn, and no agent

#### Scenario: A subagent's change
- **WHEN** in a turn of the main conversation Claude starts a subagent with an `Agent` call, and the subagent edits `b.ts`
- **THEN** the change keeps the edit call's id, the subagent's own turn, the subagent, the main conversation's turn that started it, and that `Agent` call

#### Scenario: An agent started by a subagent
- **WHEN** a subagent starts another agent, and that agent edits `c.ts`
- **THEN** the change keeps the main conversation's turn and the `Agent` call that started the first subagent

### Requirement: Turns and agents survive a reload
A change's call, turn, agent, main conversation turn and `Agent` call SHALL survive a reload of the plugin within the session, along with the change.

#### Scenario: Reload
- **WHEN** a subagent edits `b.ts`, and the plugin reloads
- **THEN** the change still keeps its call, turn, agent, main conversation turn and `Agent` call, and Show in conversation and the chip still work for it

### Requirement: Changes saved without turns still load
A change saved by an earlier version of the plugin, which kept its number and tool but not its turn or agent, SHALL still survive a reload into this version, with no turn, agent, main conversation turn or `Agent` call.

#### Scenario: Reload across the update that keeps turns
- **WHEN** two changes, one of them played, were saved by a version that kept numbers and tools but not turns, and the plugin reloads into this version
- **THEN** both changes load with their numbers, tools and played state, and Show in conversation still scrolls to each call

### Requirement: Show in conversation from the pane
While the pane shows a change, its header SHALL have a Show in conversation button. Each row of the changes list SHALL have a ↗ button beside it. Pressing either SHALL scroll the conversation to the `Edit` or `Write` call that made that change, and SHALL NOT change playback.

#### Scenario: From the header
- **WHEN** the pane is typing change #3 and the user presses Show in conversation
- **THEN** the conversation scrolls to the call that made change #3, and typing goes on

#### Scenario: From a row
- **WHEN** the user presses the ↗ beside change #1's row while change #3 is typing
- **THEN** the conversation scrolls to the call that made change #1, and change #3 goes on typing

#### Scenario: Nothing shown
- **WHEN** no change has been recorded
- **THEN** the pane has no Show in conversation button

### Requirement: Show in conversation falls back to the Agent call
When the call that made a change is not in the conversation, Show in conversation SHALL scroll to the `Agent` call that started the change's agent instead. When neither is in the conversation, the pane SHALL say that the call is no longer in the conversation, until the user next presses something in the pane.

#### Scenario: A subagent's change
- **WHEN** the conversation does not show a subagent's own calls, and the user presses the ↗ beside a change that subagent made
- **THEN** the conversation scrolls to the `Agent` call that started the subagent

#### Scenario: The call is gone
- **WHEN** the call that made a main conversation change is no longer in the conversation, and the user presses its ↗
- **THEN** the pane says that the call is no longer in the conversation, and playback does not change

### Requirement: A chip on the call's row
In the conversation, the row of each `Edit` or `Write` call whose change the plugin keeps SHALL keep the engine's own drawing and add a chip naming the change's state and number: Replay when it has played, Typing or Paused when it is being typed, Next when the pane shows it cued, Queued when it waits, Too large when it is the pane's current change and too large to replay, and Not typed when it is too large and has passed.

#### Scenario: States
- **WHEN** change #1 has played, change #2 is being typed and change #3 waits
- **THEN** the rows of their calls show Replay #1, Typing #2 and Queued #3

#### Scenario: Paused and next
- **WHEN** playback is paused while typing change #2, and later the user picks change #1 while paused
- **THEN** change #2's call row shows Paused #2, and after the pick change #1's shows Next #1

#### Scenario: Too large
- **WHEN** change #4 is too large to replay, first while the pane shows it and then after it has passed
- **THEN** its call row shows Too large #4, then Not typed #4

#### Scenario: Calls with no kept change
- **WHEN** an `Edit` call failed, or its change was dropped to stay within the limits, or the call is a `Bash` call
- **THEN** its row is drawn as the engine draws it, with no chip

#### Scenario: Not on the terminal
- **WHEN** the conversation is drawn on the terminal
- **THEN** no call row has a chip

### Requirement: Pressing the chip plays from its change
Pressing a call row's chip SHALL play from that change, as pressing its row in the changes list does, and SHALL open the pane when it is not open.

#### Scenario: Replay from the conversation
- **WHEN** everything has played and the pane is closed, and the user presses Replay #2 on a call row
- **THEN** the pane opens and types change #2, then the changes after it

#### Scenario: While paused
- **WHEN** playback is paused and the user presses Queued #5 on a call row
- **THEN** the pane shows change #5 cued as it was before, and the chip reads Next #5 until playback resumes
