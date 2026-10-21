# Tasks

## 1. File format

- [x] 1.1 Add `parseRepoSettings`, `changedKeys`, and the key kind table to `src/repoSettings.ts`; verify unit tests in `test/repoSettings.test.ts` cover valid values, unknown keys, wrong types (string for array, array with a non-string, non-finite number, bad enum), `$schema`, a non-object root, and invalid JSON
- [x] 1.2 Add `schemas/agent-typewriter.schema.json`, `contributes.jsonValidation`, and the schema to `.vscodeignore`; verify a unit test asserts the schema properties, the kind table, and `contributes.configuration` keys are the same set, and `npm run package` includes the schema in the .vsix

## 2. Precedence

- [x] 2.1 Add a pure `pickLayer(workspaceValue, repoValue, below)` in `src/repoSettings.ts`, plus `setRepoValues` in `src/config.ts`, and make `readSettings` resolve every key through it; verify unit tests cover workspace over file, file over user, user and default when the file is silent, and `npm run typecheck` passes

## 3. Loader and wiring

- [x] 3.1 Add `RepoSettingsFile` in `src/repoSettingsFile.ts` (read, watch, re-target on folder changes, keep last valid values on bad JSON, `ready`, `onDidChange` with changed keys, problem logging including keys overridden by workspace settings)
- [x] 3.2 In `src/extension.ts`, extract `applySettingsChange` from the configuration handler, feed it file changes, call `setRepoValues`, and make `start` await `ready`; verify the existing integration sections still pass
- [x] 3.3 Add the **Open Repository Settings File** command (open existing, or untitled prefilled with filters) to `package.json` and `src/extension.ts`, including the view's `...` menu

## 4. Docs

- [x] 4.1 Add a README section on the repository file: location, format, example, precedence, live reload, the open command; verify it matches the spec

## 5. Integration checks

- [x] 5.1 Add an integration section that writes `.agent-typewriter.json` while watching and asserts: a file-set filter applies to the next write, a workspace setting overrides the file and clearing it falls back to the file, a syntax error keeps the previous values, deleting the file removes them; verify `npm run it` passes locally and on CI (Ubuntu and Windows)
- [x] 5.2 Assert in the integration section that running **Open Repository Settings File** with no file leaves no file on disk and opens an untitled editor with the filters

## Workflow follow-up

- Archive on the PR branch once tasks are done and CI is green, then merge.
- Close at-kbn.1 after the merge.
