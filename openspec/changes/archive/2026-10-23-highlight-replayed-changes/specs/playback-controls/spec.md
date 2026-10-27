# Spec Delta

## ADDED Requirements

### Requirement: Clear highlights controls
The playback mirror's editor title bar SHALL show a Clear Highlights in This File button while that mirror has highlights or removal markers. The Playback panel SHALL show a Clear Highlights button, enabled while any mirror has them. Both commands SHALL be in the command palette. Each control SHALL behave the same as the matching command.

#### Scenario: Title bar button
- **WHEN** the playback mirror `a.ts` has highlights and the user presses Clear Highlights in This File in its title bar
- **THEN** `a.ts`'s highlights and removal markers disappear, and other files keep theirs

#### Scenario: First highlights while typing
- **WHEN** highlights were cleared and a change starts typing new text into the playback mirror
- **THEN** its title bar shows Clear Highlights in This File and the panel's Clear Highlights is enabled before the change finishes

#### Scenario: No highlights
- **WHEN** the playback mirror has no highlights or removal markers
- **THEN** its title bar shows no Clear Highlights in This File button

#### Scenario: Panel button
- **WHEN** `a.ts` and `b.ts` have highlights and the user presses Clear Highlights in the Playback panel
- **THEN** both files' highlights and removal markers disappear, and the panel's button is disabled

#### Scenario: Other tabs
- **WHEN** a mirror tab that is not the playback mirror has highlights
- **THEN** its title bar shows no Clear Highlights in This File button, and the command palette's Clear Highlights in This File clears it while it is the active editor
