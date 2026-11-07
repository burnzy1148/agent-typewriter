# Spec Delta

## ADDED Requirements

### Requirement: Each change keeps the agent's words before its call
For each change it records, the plugin SHALL keep as its caption the visible text the agent wrote in the same response before the `Edit` or `Write` call, after any earlier tool call in that response. A call with no text of its own that directly follows another call in the same response SHALL share that call's caption. Thinking SHALL NOT be a caption, and text from an earlier response SHALL NOT carry over. A change with no such text SHALL have no caption.

#### Scenario: Text before the call
- **WHEN** Claude writes "Now I'll guard the login route." and then calls `Edit` on `login.ts` in the same response
- **THEN** that change's caption is "Now I'll guard the login route."

#### Scenario: Text between two calls
- **WHEN** in one response Claude writes "Add the limiter.", calls `Write` on `limiter.ts`, writes "Export it.", and calls `Edit` on `index.ts`
- **THEN** the `limiter.ts` change's caption is "Add the limiter." and the `index.ts` change's caption is "Export it."

#### Scenario: Calls made together
- **WHEN** in one response Claude writes "Update both callers." and then calls `Edit` on `signup.ts` and `Edit` on `login.ts` with no text between them
- **THEN** both changes have the caption "Update both callers."

#### Scenario: Text before another tool
- **WHEN** Claude writes "Let me read the file.", calls `Read`, and in its next response calls `Edit` with no text before it
- **THEN** the change has no caption

#### Scenario: Another tool in between, then text
- **WHEN** in one response Claude writes "Checking first.", calls `Grep`, writes "Fix the typo.", and calls `Edit`
- **THEN** the change's caption is "Fix the typo."

#### Scenario: Thinking only
- **WHEN** Claude thinks and then calls `Edit` without writing visible text
- **THEN** the change has no caption

### Requirement: Captions come from the loop that made the change
The plugin SHALL take a change's caption only from the loop whose call made it: the main conversation's text for a main conversation change, and a subagent's or teammate's own text for that agent's change. Text written in one loop SHALL NOT become the caption of a change made in another, including while several loops run at once.

#### Scenario: Two subagents at once
- **WHEN** two subagents run at the same time, one writes "Covering the refill." before it calls `Write` on `limiter.test.ts`, and the other writes "Signup gets the same guard." before it calls `Edit` on `signup.ts`
- **THEN** the `limiter.test.ts` change's caption is "Covering the refill." and the `signup.ts` change's caption is "Signup gets the same guard."

#### Scenario: Main conversation text before an agent
- **WHEN** Claude writes "I'll hand the tests to a subagent." and calls `Agent`, and the subagent calls `Write` with no text of its own before it
- **THEN** the subagent's change has no caption

### Requirement: Captions are kept as the conversation keeps the text
A caption SHALL be the text as the conversation keeps it, after any rewrite another plugin makes, with runs of whitespace and line breaks shown as single spaces and control characters shown as visible symbols. Reading the agent's text SHALL NOT change any row of the conversation, and a failure while reading it SHALL NOT affect the conversation or the recording of the change, which then has no caption.

#### Scenario: Several paragraphs
- **WHEN** Claude writes two paragraphs before an `Edit` call
- **THEN** the change's caption is both paragraphs joined by a single space

#### Scenario: Rewritten text
- **WHEN** another plugin rewrites a token in Claude's text to `***` before the conversation keeps it, and Claude then calls `Edit`
- **THEN** the caption shows `***`, as the conversation does

#### Scenario: The conversation is untouched
- **WHEN** Claude writes text and calls `Edit`
- **THEN** the conversation keeps that text and that call exactly as it would without the plugin

### Requirement: The caption shows over the code
While the pane shows a change that has a caption, it SHALL show the caption in quotes between the pane's header and the code, set apart from the code, cut with an ellipsis to fit at most three lines of the pane's width. The code SHALL give up the rows the caption takes. While the pane shows a change with no caption, or no change, it SHALL draw no caption.

#### Scenario: Typing a change with a caption
- **WHEN** the pane types a change whose caption is "Export it from the auth index."
- **THEN** “Export it from the auth index.” shows between the header and the code while it types

#### Scenario: The caption follows the shown change
- **WHEN** the change with that caption finishes and the next change, with no caption, starts typing
- **THEN** the pane draws no caption and the code takes its rows back

#### Scenario: Paused, picked or done
- **WHEN** playback is paused on a change, a picked change waits while paused, or the last change has finished
- **THEN** the pane shows the caption of the change it shows

#### Scenario: A long caption
- **WHEN** the shown change's caption needs more than three lines at the pane's width
- **THEN** the pane shows its first three lines, the last ending in an ellipsis

#### Scenario: A too-large change
- **WHEN** the pane shows a change too large to type, and it has a caption
- **THEN** the caption shows above the note that the file is too large to replay

### Requirement: A row's hover card shows its caption
On a surface with a pointer, resting the pointer on a change's row in the changes list SHALL show a card with that change's caption, cut with an ellipsis to fit the card, over the rows near it without moving them. Moving the pointer off the row SHALL hide the card. A row whose change has no caption SHALL show no card, and showing a card SHALL NOT change playback.

#### Scenario: Hovering a played change
- **WHEN** change #4 has played, its caption is "Trust the proxy so the limiter sees client addresses.", and the user rests the pointer on its row
- **THEN** a card shows that caption beside the row, and playback goes on as it was

#### Scenario: A row without a caption
- **WHEN** the user rests the pointer on the row of a change with no caption
- **THEN** no card shows

#### Scenario: The rows stay put
- **WHEN** a card shows
- **THEN** no row of the list moves, and pressing a row still plays from it

### Requirement: Captions survive a reload
A change's caption SHALL survive a reload of the plugin within the session, along with the change. Changes saved by an earlier version of the plugin, which kept no captions, SHALL still load, with no caption.

#### Scenario: Reload
- **WHEN** a change with a caption has been recorded and the plugin reloads
- **THEN** the change keeps its caption, in the pane and in its row's card

#### Scenario: Reload across the update that keeps captions
- **WHEN** two changes were saved by a version that kept no captions, and the plugin reloads into this version
- **THEN** both changes load with their numbers, tools, turns and played state, and neither has a caption
