# Spec Delta

## ADDED Requirements

### Requirement: Highlight clears survive a reload
With `agentTypewriter.persistHistory` on, the saved timeline SHALL keep the highlight clears in effect, for all files and for single files, so highlights after a reload match those before it. A clear whose change was left out of the restored timeline SHALL be dropped. Timelines saved without this information SHALL restore with no clears. A loaded session file SHALL start with no highlights.

#### Scenario: Reload after clearing
- **WHEN** the user clears highlights, plays a change that adds a line to `a.ts`, and reloads the window
- **THEN** `a.ts`'s restored mirror highlights only that line

#### Scenario: Reload while a change is typing
- **WHEN** the user clears highlights while a change is being typed, and the window is reloaded before it finishes
- **THEN** after the reload and that change's replay, no file shows highlights from before the clear

#### Scenario: Timeline saved by an earlier version
- **WHEN** the saved timeline was written before this change
- **THEN** it restores normally, and each file is highlighted against the before text of its earliest change

#### Scenario: Load a session file
- **WHEN** the user loads a session file
- **THEN** every change is pending and no mirror shows highlights until changes play
