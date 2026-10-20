# Proposal

## Why

Replay types every file at one global `charsPerSecond`. Prose and data files like Markdown and JSON look unnaturally slow next to code, and dense code can look too fast. Setting a base speed per language makes playback look more like a real person working across file types.

## What Changes

- New setting `agentTypewriter.languageSpeeds`: an object that maps a VS Code language ID (such as `markdown` or `json`) to a base typing speed in characters per second.
- During playback, the speed for each mirror document comes from its language ID. Languages that aren't listed keep using `charsPerSecond`.
- Catch-up speedup and the manual speed control still multiply on top of whichever base speed applies.
- Invalid entries (zero, negative, or not a number) are ignored, so that language falls back to `charsPerSecond`.

## Capabilities

### New Capabilities

- `typing-pace`: how fast replay types a change, including the base speed and how it is chosen per document.

### Modified Capabilities

None. No specs exist yet.

## Impact

- `package.json`: new `agentTypewriter.languageSpeeds` configuration entry.
- `src/config.ts`: reads the setting into `Settings`.
- New pure module (for example `src/pace.ts`) that picks the base speed for a language, so it can be unit tested.
- `src/player.ts`: `cps()` uses the base speed for the editor's language.
- `test/`: unit tests for choosing the speed.
