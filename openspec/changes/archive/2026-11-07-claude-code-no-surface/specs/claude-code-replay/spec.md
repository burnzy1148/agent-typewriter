## ADDED Requirements

### Requirement: `/typewriter` says when the pane can't be shown
`/typewriter` SHALL answer "Agent Typewriter pane opened." only when Claude Code places the pane. When no surface is attached to the session, the answer SHALL say the pane can't be shown in this session and name a local session in the Claude Code desktop app or in VS Code as where it can. Any other reason the pane is not placed SHALL get the same pointer with Claude Code's reason in it. The pane stays open, so a surface that attaches later draws it.

#### Scenario: Command in a cloud session
- **WHEN** the user runs `/typewriter` in a session that no surface is attached to, such as a cloud session
- **THEN** the answer says the pane can't be shown here and points to a local session in the desktop app or VS Code, and does not say the pane opened

#### Scenario: Command in the desktop app
- **WHEN** the user runs `/typewriter` in a local desktop app session and the pane is placed
- **THEN** the answer is "Agent Typewriter pane opened."

#### Scenario: Placed nowhere for another reason
- **WHEN** the user runs `/typewriter` and Claude Code leaves the pane unplaced for a reason other than having no surface
- **THEN** the answer includes that reason and the pointer, and does not say the pane opened

### Requirement: The first change says when no surface can show the pane
When the session records its first change and no surface is attached to the session, the plugin SHALL add one notice to the transcript that says the pane can't be shown in this session and names a local session in the Claude Code desktop app or in VS Code as where it can. The notice SHALL NOT be sent to the model. When the pane is left unplaced for any other reason, the plugin SHALL add no notice. Recording SHALL continue either way.

#### Scenario: First change in a cloud session
- **WHEN** Claude edits a file in a session that no surface is attached to, and it is the session's first recorded change
- **THEN** the transcript gets one notice pointing to a local session in the desktop app or VS Code, and the change is recorded

#### Scenario: Later changes in a cloud session
- **WHEN** Claude edits more files in that session
- **THEN** no further notice is added

#### Scenario: Unasked pane below the width floor
- **WHEN** the first change is recorded and Claude Code leaves the pane unplaced because the window is too narrow for a pane nobody asked for
- **THEN** no notice is added and the pane waits for `/typewriter`
