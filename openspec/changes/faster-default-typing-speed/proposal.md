# Proposal

## Why

At the 350 characters per minute default, replay of a typical agent edit lags well behind the agent and reads as sluggish. About 1000 characters per minute still looks like typing but keeps up better.

## What Changes

- The default `agentTypewriter.charsPerMinute` goes from 350 to 1000. Anyone who set `charsPerMinute` (or the deprecated `charsPerSecond`) in any layer keeps their value.
- The `languageSpeeds` example in the setting description and docs becomes `{ "markdown": 1500, "json": 1200 }`, so the example still speeds a language up relative to the new default.

## Capabilities

### New Capabilities
None.

### Modified Capabilities
- `typing-pace`: the default base speed becomes 1000 characters per minute, and the scenarios use the new default and a 1500 Markdown speed.

## Impact

- `src/pace.ts`: `DEFAULT_CHARS_PER_MINUTE`.
- `package.json` and `schemas/agent-typewriter.schema.json`: the `charsPerMinute` default and the `languageSpeeds` example.
- The site docs: the repository settings example. The settings reference is generated from `package.json`.
- `test/pace.test.ts`, `test/repoSettings.test.ts` and `it/suite.ts`: the expected default and example values.
- CHANGELOG.
- Bead `at-mfk.6`.
