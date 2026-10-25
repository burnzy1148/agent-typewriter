# Spec Delta

## MODIFIED Requirements

### Requirement: Default base speed
Replay SHALL type at the `agentTypewriter.charsPerMinute` base speed, in characters per minute, in any mirror document whose language has no valid per-language speed configured. When no layer sets a base speed, it SHALL be 1000 characters per minute.

#### Scenario: No per-language speeds configured
- **WHEN** `languageSpeeds` is empty and `charsPerMinute` is 1000
- **THEN** a change to any file is typed at a base speed of 1000 characters per minute

#### Scenario: Nothing configured
- **WHEN** neither `charsPerMinute` nor `charsPerSecond` is set in workspace settings, the repository file, or user settings
- **THEN** the base speed is 1000 characters per minute

#### Scenario: Language not listed
- **WHEN** `languageSpeeds` is `{ "markdown": 1500 }`
- **AND** a change to a TypeScript file is played
- **THEN** it is typed at the `charsPerMinute` base speed

### Requirement: Per-language base speed
Replay SHALL use the speed configured in `agentTypewriter.languageSpeeds` for the mirror document's VS Code language ID as the base speed, instead of `charsPerMinute`. Values SHALL be in characters per minute. Language IDs SHALL match exactly as VS Code reports them.

#### Scenario: Listed language
- **WHEN** `languageSpeeds` is `{ "markdown": 1500 }` and `charsPerMinute` is 1000
- **AND** a change to a Markdown file is played
- **THEN** it is typed at a base speed of 1500 characters per minute

#### Scenario: Switching files of different languages
- **WHEN** `languageSpeeds` is `{ "json": 1200 }` and `charsPerMinute` is 1000
- **AND** a change to `data.json` is played, followed by a change to `main.ts`
- **THEN** the JSON change is typed at a base speed of 1200 characters per minute and the TypeScript change at 1000

#### Scenario: Values written for the old unit
- **WHEN** `languageSpeeds` is `{ "markdown": 60 }`, a value chosen when it meant characters per second
- **THEN** a Markdown change is typed at a base speed of 60 characters per minute
