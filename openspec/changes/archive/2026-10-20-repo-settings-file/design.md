# Design

## Context

`readSettings()` in `src/config.ts` reads every value synchronously through `vscode.workspace.getConfiguration('agentTypewriter').get(...)`, and it is called often (the player reads it per change, the recorder per write). Filter commands (`setExtensions`, `watchOnlyThis`, `addToWatch`, `resetFilters`) write through `updateSetting`, which targets workspace settings when a folder is open. `onDidChangeConfiguration` in `src/extension.ts` reacts to filter, history, and baseline keys. The project rule that the extension never writes the user's real files constrains how the new file can be created.

## Goals / Non-Goals

**Goals:**
- One committable file that can carry any `agentTypewriter.*` setting, filters first.
- A precedence that lets a repository set defaults for everyone but still lets a person override locally with the existing commands.
- Reuse the existing reaction to settings changes for file changes.
- A file format kbn.4 (named filter profiles) can extend with new top-level keys.

**Non-Goals:**
- One file per folder in multi-root workspaces. Only the first folder's file is read, the same way one set of workspace settings applies to every folder today.
- YAML, or JSON with comments. Strict JSON only.
- Writing to the file from commands.

## Decisions

### JSON at `.agent-typewriter.json` in the first folder's root
JSON needs no new dependency, and VS Code can validate and complete it through `contributes.jsonValidation` with a schema we ship. YAML would need a parser dependency and gets no schema support without another extension. A root dotfile matches conventions like `.editorconfig` and `.prettierrc`; `.vscode/agent-typewriter.json` was considered, but `.vscode/` is often gitignored, which defeats the purpose.

### Precedence: default < user < file < workspace
Alternatives:
- File wins over everything. Then the filter commands, which write workspace settings, silently stop working for any key the file sets, unless they write to the file, which the project rule forbids.
- File is lowest (only fills in defaults). Then a personal user setting such as `extensions: ["ts"]` overrides every repository's filters, which defeats sharing.

Placing the file between user and workspace mirrors how a project's workspace settings already outrank user settings, keeps the commands effective as local overrides, and makes **Reset Filters** a way back to the repository's filters. Resolution uses `getConfiguration(SECTION).inspect(key)`: `workspaceValue` if defined, else the file value if valid, else `get(key, fallback)` (user or default). `workspaceFolderValue` is not consulted, as today `readSettings` reads unscoped configuration.

When the file sets a key that workspace settings override, the output channel says so on load, since that is the likeliest "my file is ignored" confusion.

### Cached file values behind the synchronous `readSettings`
Two new modules:
- `src/repoSettings.ts`, pure so unit tests can load it without VS Code: `parseRepoSettings(text)`, Returns `{ values, problems }` or a parse error. Validates each key against a kind table (`stringArray`, `number`, `boolean`, `string`, `object`, `enum`, or `any` for `reorderWindowMs`, whose existing resolver already handles bad values).
  plus `pickLayer` for the precedence and `changedKeys`.
- `src/repoSettingsFile.ts`, `RepoSettingsFile`: reads the file with `vscode.workspace.fs`, watches it with a `FileSystemWatcher` on `RelativePattern(firstFolder, '.agent-typewriter.json')`, re-targets on `onDidChangeWorkspaceFolders`, and exposes `values`, a `ready` promise for the first load, and `onDidChange(changedKeys)`.

`config.ts` gets `setRepoValues(values)`, which `extension.ts` calls whenever the loader changes, and `readSettings` consults those values per key. This keeps `readSettings` synchronous and its call sites unchanged.

Alternative considered: passing the file values into every `readSettings()` call. It touches every caller for no benefit, since there is one file per window.

### One change handler for settings and file
`onDidChangeConfiguration`'s body becomes `applySettingsChange(affects: (key) => boolean)`. Config events pass `k => e.affectsConfiguration('agentTypewriter.' + k)`; file events pass the set of keys whose value differs between the old and new file contents. That gives live filter refresh, history limit, and baseline refresh for file edits with no duplicated logic.

### Activation order
`activate` stays synchronous. The `start` command awaits `repoFile.ready` before starting the recorder, so `autoStart` and a fast first start see the file's filters. The timeline is created with the settings-only `historyLimit`, then the first load fires `onDidChange` like any later change and `setLimit` applies the file's value.

### Invalid JSON keeps the previous values
While someone edits the file, a save with a syntax error is common. Keeping the last valid values avoids filters flapping to the settings values and back, which would drop baselines and re-snapshot. A warning notification is shown once per broken state, and the details go to the output channel. On the first load a broken file contributes nothing.

### Creating the file without writing it
**Open Repository Settings File** opens the file if it exists. Otherwise it opens `untitled:` at the target path with current `include`, `exclude`, and `extensions`, so saving writes the file through the user's own save. Because it is a user save, `ignoreOwnSaves` keeps it out of the replay.

### Schema kept in sync by a unit test
`schemas/agent-typewriter.schema.json` lists the same properties as `contributes.configuration` without the prefix. A unit test asserts the schema properties, the parser's kind table, and the `package.json` configuration keys are the same set, so adding a setting without updating the file format fails `npm test`.

## Risks / Trade-offs

- [A workspace setting silently overrides a file value] → Logged on load; README explains the order.
- [The file is a workspace file and passes default filters, so editing it while watching records it] → Accepted: it is a real change to a real file, like any other.
- [A cloned repository sets `autoStart`] → The extension only reads files and writes mirror documents, and it does not run in untrusted workspaces (no `untrustedWorkspaces` support is declared), so a repository can at most start a read-only watch.
- [File watcher misses an event] → The file is re-read on every create, change, and delete event and on folder changes; values are compared, so duplicate events are harmless.
