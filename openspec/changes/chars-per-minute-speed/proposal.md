# Proposal

## Why

Typing speed is configured in characters per second, which gives coarse, unfamiliar numbers (a believable typist is around 5 per second). Characters per minute is the unit people already use for typing speed, allows finer steps, and reads naturally in the Settings UI. The default also moves to a human pace of 350 characters per minute.

## What Changes

- New setting `agentTypewriter.charsPerMinute` (default `350`, minimum `1`) replaces `agentTypewriter.charsPerSecond` as the base typing speed.
- The default base speed changes from 35 characters per second (2100 per minute) to 350 characters per minute (about 5.8 per second). Users on the default see replay 6x slower before catch-up acceleration.
- **BREAKING**: `agentTypewriter.languageSpeeds` values are read as characters per minute. An existing entry such as `{ "markdown": 60 }` now means 60 per minute instead of 60 per second. Called out in the changelog and README.
- `agentTypewriter.charsPerSecond` stays as a deprecated fallback: when a settings layer (workspace settings, the repository file, or user settings) sets `charsPerSecond` but not `charsPerMinute`, its value times 60 is used for that layer. The Settings UI marks it deprecated, and the output channel says once when a deprecated value is in effect. No settings are rewritten.
- `.agent-typewriter.json` accepts `charsPerMinute`; `charsPerSecond` is still accepted there as the deprecated fallback.
- User-facing text switches to per minute: the **Set Playback Speed...** quick pick ("Base speed..." entry and its input box), setting descriptions in `package.json` and the JSON schema, README, and the changelog.

## Capabilities

### New Capabilities
None.

### Modified Capabilities
- `typing-pace`: base and per-language speeds are in characters per minute, the default is 350, and a deprecated `charsPerSecond` value is honored as a fallback.
- `repo-settings`: scenarios that use `charsPerSecond` as their example setting move to `charsPerMinute`.

## Impact

- `src/pace.ts`: base speed resolved in characters per minute, plus a pure helper that resolves `charsPerMinute` per layer with the `charsPerSecond` fallback.
- `src/config.ts`: `Settings.charsPerMinute` replaces `charsPerSecond`; layered resolution uses the fallback helper.
- `src/player.ts`: converts the per-minute base to per-second internally; pacing math is otherwise unchanged.
- `src/extension.ts`: speed quick pick and input box text and the setting they write; one-time deprecation note in the output channel.
- `src/repoSettings.ts`, `package.json`, `schemas/agent-typewriter.schema.json`: new setting, deprecated old one, updated descriptions.
- README settings table and repository-file example; CHANGELOG entry.
- Unit tests (`test/pace.test.ts`, `test/repoSettings.test.ts`) and integration tests (`it/runTest.ts`, `it/suite.ts`) move to the new setting.
