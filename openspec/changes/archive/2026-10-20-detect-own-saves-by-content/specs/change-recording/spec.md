# Spec Delta

## ADDED Requirements

### Requirement: Own saves are recognized by content
With `agentTypewriter.ignoreOwnSaves` on, a change SHALL be skipped as the user's own only when the file's text on disk matches the text a VS Code editor save wrote to that file. Line endings SHALL NOT affect the match. How long ago the save happened SHALL NOT matter.

#### Scenario: Plain own save
- **WHEN** the user edits `a.ts` in an editor and saves it, and nothing else writes the file
- **THEN** no change is recorded for that save
- **AND** the next outside change to `a.ts` uses the saved text as its before text

#### Scenario: Outside write long after a save
- **WHEN** the user saves `a.ts`, and an agent writes `a.ts` 3 s later, past the old 2 s window
- **THEN** the agent's write is recorded as a change

#### Scenario: Setting off
- **WHEN** `ignoreOwnSaves` is off and the user saves `a.ts`
- **THEN** the save is recorded as a change, as before

### Requirement: Outside write right after a save is recorded
When the file's text on disk differs from what the latest editor save wrote, the recorder SHALL record a change whose before text is the saved text and whose after text is the disk text, even when both writes were merged into one debounced change.

#### Scenario: Agent writes right after the user's save
- **WHEN** the user's unsaved edit to `a.ts` is saved and an agent writes a different version of `a.ts` 50 ms later
- **THEN** exactly one change is recorded for `a.ts`
- **AND** its before text is the text the user saved and its after text is the agent's version
- **AND** replay types only the agent's edit

### Requirement: Save participants count as the user's
Text written by a save, including edits that save participants such as format on save make, SHALL count as the user's. When a change is read after a save starts but before it finishes, the recorder SHALL wait up to one second for the save to finish before comparing.

#### Scenario: Format on save
- **WHEN** the user saves `a.ts` and format on save rewrites part of it during the save
- **THEN** no change is recorded for that save

#### Scenario: Save never finishes
- **WHEN** a save starts and does not finish within one second of the change being read
- **THEN** the recorder compares against the text known when the save started
