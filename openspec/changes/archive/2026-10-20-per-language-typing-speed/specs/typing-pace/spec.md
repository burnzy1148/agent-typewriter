# Spec Delta

## Purpose

Controls how fast replay types each change into a mirror document, so playback looks like a person typing at a believable pace for the kind of file being edited.

## ADDED Requirements

### Requirement: Default base speed
Replay SHALL type at the `agentTypewriter.charsPerSecond` base speed in any mirror document whose language has no valid per-language speed configured.

#### Scenario: No per-language speeds configured
- **WHEN** `languageSpeeds` is empty and `charsPerSecond` is 35
- **THEN** a change to any file is typed at a base speed of 35 characters per second

#### Scenario: Language not listed
- **WHEN** `languageSpeeds` is `{ "markdown": 60 }`
- **AND** a change to a TypeScript file is played
- **THEN** it is typed at the `charsPerSecond` base speed

### Requirement: Per-language base speed
Replay SHALL use the speed configured in `agentTypewriter.languageSpeeds` for the mirror document's VS Code language ID as the base speed, instead of `charsPerSecond`. Language IDs SHALL match exactly as VS Code reports them.

#### Scenario: Listed language
- **WHEN** `languageSpeeds` is `{ "markdown": 60 }` and `charsPerSecond` is 35
- **AND** a change to a Markdown file is played
- **THEN** it is typed at a base speed of 60 characters per second

#### Scenario: Switching files of different languages
- **WHEN** `languageSpeeds` is `{ "json": 120 }` and `charsPerSecond` is 35
- **AND** a change to `data.json` is played, followed by a change to `main.ts`
- **THEN** the JSON change is typed at a base speed of 120 and the TypeScript change at 35

### Requirement: Invalid per-language speeds are ignored
An entry in `languageSpeeds` whose value is not a finite number greater than zero SHALL be ignored, so that language uses `charsPerSecond`. Invalid entries MUST NOT stop or fail playback.

#### Scenario: Zero, negative, or non-numeric value
- **WHEN** `languageSpeeds` is `{ "markdown": 0, "json": -5, "yaml": "fast" }`
- **THEN** changes to Markdown, JSON, and YAML files are typed at the `charsPerSecond` base speed

### Requirement: Speed multipliers apply on top of the base speed
The catch-up speedup and the manual playback speed SHALL multiply whichever base speed applies, whether it comes from a per-language entry or from `charsPerSecond`.

#### Scenario: Manual speed with a per-language base
- **WHEN** `languageSpeeds` is `{ "markdown": 60 }`
- **AND** the manual playback speed is 2x and no changes are queued behind the current one
- **THEN** a Markdown change is typed at 120 characters per second
