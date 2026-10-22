# Spec Delta

## MODIFIED Requirements

### Requirement: Default base speed
Replay SHALL type at the `agentTypewriter.charsPerMinute` base speed, in characters per minute, in any mirror document whose language has no valid per-language speed configured. When no layer sets a base speed, it SHALL be 350 characters per minute.

#### Scenario: No per-language speeds configured
- **WHEN** `languageSpeeds` is empty and `charsPerMinute` is 350
- **THEN** a change to any file is typed at a base speed of 350 characters per minute

#### Scenario: Nothing configured
- **WHEN** neither `charsPerMinute` nor `charsPerSecond` is set in workspace settings, the repository file, or user settings
- **THEN** the base speed is 350 characters per minute

#### Scenario: Language not listed
- **WHEN** `languageSpeeds` is `{ "markdown": 600 }`
- **AND** a change to a TypeScript file is played
- **THEN** it is typed at the `charsPerMinute` base speed

### Requirement: Per-language base speed
Replay SHALL use the speed configured in `agentTypewriter.languageSpeeds` for the mirror document's VS Code language ID as the base speed, instead of `charsPerMinute`. Values SHALL be in characters per minute. Language IDs SHALL match exactly as VS Code reports them.

#### Scenario: Listed language
- **WHEN** `languageSpeeds` is `{ "markdown": 600 }` and `charsPerMinute` is 350
- **AND** a change to a Markdown file is played
- **THEN** it is typed at a base speed of 600 characters per minute

#### Scenario: Switching files of different languages
- **WHEN** `languageSpeeds` is `{ "json": 1200 }` and `charsPerMinute` is 350
- **AND** a change to `data.json` is played, followed by a change to `main.ts`
- **THEN** the JSON change is typed at a base speed of 1200 characters per minute and the TypeScript change at 350

#### Scenario: Values written for the old unit
- **WHEN** `languageSpeeds` is `{ "markdown": 60 }`, a value chosen when it meant characters per second
- **THEN** a Markdown change is typed at a base speed of 60 characters per minute

### Requirement: Invalid per-language speeds are ignored
An entry in `languageSpeeds` whose value is not a finite number greater than zero SHALL be ignored, so that language uses `charsPerMinute`. Invalid entries MUST NOT stop or fail playback.

#### Scenario: Zero, negative, or non-numeric value
- **WHEN** `languageSpeeds` is `{ "markdown": 0, "json": -5, "yaml": "fast" }`
- **THEN** changes to Markdown, JSON, and YAML files are typed at the `charsPerMinute` base speed

### Requirement: Speed multipliers apply on top of the base speed
The catch-up speedup and the manual playback speed SHALL multiply whichever base speed applies, whether it comes from a per-language entry or from `charsPerMinute`.

#### Scenario: Manual speed with a per-language base
- **WHEN** `languageSpeeds` is `{ "markdown": 600 }`
- **AND** the manual playback speed is 2x and no changes are queued behind the current one
- **THEN** a Markdown change is typed at 1200 characters per minute

## ADDED Requirements

### Requirement: Deprecated per-second setting is honored
For each settings layer (workspace settings, the repository file, user settings), when that layer sets `charsPerSecond` but not `charsPerMinute`, the layer's base speed SHALL be its `charsPerSecond` value times 60. Layers SHALL keep their usual priority. The extension SHALL NOT rewrite either setting.

#### Scenario: Only the old setting is set
- **WHEN** the user settings set `charsPerSecond` to 10 and no layer sets `charsPerMinute`
- **THEN** the base speed is 600 characters per minute

#### Scenario: Both settings in the same layer
- **WHEN** the user settings set `charsPerSecond` to 10 and `charsPerMinute` to 400
- **THEN** the base speed is 400 characters per minute

#### Scenario: Old setting in a higher layer
- **WHEN** the repository file sets `charsPerSecond` to 10 and the user settings set `charsPerMinute` to 400, with no workspace value
- **THEN** the base speed is 600 characters per minute

#### Scenario: New setting in a higher layer
- **WHEN** the workspace settings set `charsPerMinute` to 400 and the user settings set `charsPerSecond` to 10
- **THEN** the base speed is 400 characters per minute

### Requirement: Deprecated per-second setting is reported
When a `charsPerSecond` value determines the base speed, the extension SHALL say so in the output channel, naming `charsPerMinute` as the replacement. It SHALL NOT repeat the note until the settings change. The Settings UI SHALL show `charsPerSecond` as deprecated.

#### Scenario: Deprecated value in effect
- **WHEN** the base speed comes from the user settings' `charsPerSecond`
- **THEN** the output channel notes that `charsPerSecond` is deprecated and `charsPerMinute` replaces it

#### Scenario: New setting in effect
- **WHEN** the base speed comes from `charsPerMinute` or the default
- **THEN** no deprecation note is written
