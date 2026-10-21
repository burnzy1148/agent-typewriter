# Proposal

## Why

Which files Agent Typewriter watches, and how fast it types, live only in VS Code settings today. A team that wants everyone to watch the same files (say `src/**` but not generated code) has to share `.vscode/settings.json`, which many repositories gitignore or keep personal, and the extension's own filter commands write their changes there. A small file meant to be committed gives a repository its own Agent Typewriter defaults (bead at-kbn.1).

## What Changes

- A workspace may hold a `.agent-typewriter.json` file at the root of its first folder. It is a JSON object whose keys are `agentTypewriter.*` setting names without the prefix, for example `{ "extensions": ["ts"], "exclude": ["**/generated/**"], "charsPerSecond": 50 }`.
- Precedence, lowest to highest: built-in defaults, user settings, the repository file, workspace settings. The file overrides personal user settings, so a repository's filters apply to everyone who opens it; workspace settings, which the extension's filter commands write, still override the file for local tweaks. **Reset Filters** clears those workspace values, so the file's filters apply again.
- The file is watched. Creating, editing, or deleting it takes effect immediately, like a settings change, including re-snapshotting newly matching files while watching.
- Invalid entries are ignored with a warning in the output channel: unknown keys, and values of the wrong type. A file that is not valid JSON is reported once, and the last valid contents stay in effect until it is fixed.
- New command **Agent Typewriter: Open Repository Settings File**. If the file exists it opens it; otherwise it opens an unsaved editor for that path, prefilled with the current filter settings, for the user to save. The extension never writes the file itself.
- The file gets JSON schema validation and completion in VS Code.

## Capabilities

### New Capabilities
- `repo-settings`: a committable per-repository settings file, how its values combine with VS Code settings, live reload, and handling of invalid content.

### Modified Capabilities
None.

## Impact

- New `src/repoSettings.ts`: pure parsing and validation of the file plus a loader that reads and watches it.
- `src/config.ts`: `readSettings` resolves each key through the precedence above.
- `src/extension.ts`: loads the file before the first start, applies file changes the same way as settings changes, registers the new command.
- `src/recorder.ts`: no change beyond `refreshFilter` being called on file changes.
- `package.json`: the new command and `contributes.jsonValidation`; new `schemas/agent-typewriter.schema.json`, shipped in the .vsix through `.vscodeignore`.
- README: a section on the repository file.
- Unit tests for parsing and precedence; integration sections for loading, live reload, and precedence.
