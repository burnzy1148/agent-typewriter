# Spec Delta

## ADDED Requirements

### Requirement: Highlight clears survive a reload
With `agentTypewriter.persistHistory` on, the saved timeline SHALL keep where highlights were last cleared, for all files and for each file, so highlights after a reload match those before it. A clear whose change was left out of the restored timeline SHALL be dropped. Timelines saved without this information SHALL restore with no clears. A loaded session file SHALL start with no highlights.

#### Scenario: Reload after clearing
- **WHEN** the user clears highlights, plays a change that adds a line to `a.ts`, and reloads the window
- **THEN** `a.ts`'s restored mirror highlights only that line

#### Scenario: Timeline saved by an earlier version
- **WHEN** the saved timeline was written before this change
- **THEN** it restores normally, and each file is highlighted against the before text of its earliest change

#### Scenario: Load a session file
- **WHEN** the user loads a session file
- **THEN** every change is pending and no mirror shows highlights until changes play
