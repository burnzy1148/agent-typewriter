# repo-settings Specification

## Purpose
Lets a repository commit its own Agent Typewriter settings and filters in a file, so everyone who opens it watches the same files with the same defaults.

## Requirements

### Requirement: Repository settings file
The extension SHALL read settings from a file named `.agent-typewriter.json` at the root of the first workspace folder. The file SHALL be a JSON object whose keys are `agentTypewriter.*` setting names without the `agentTypewriter.` prefix, with values of the same types the settings accept. A `$schema` key SHALL be allowed and ignored.

#### Scenario: Filters from the file
- **WHEN** the file contains `{ "extensions": ["md"] }` and no VS Code setting sets `extensions`
- **THEN** only `.md` files are recorded

#### Scenario: No file
- **WHEN** the workspace has no `.agent-typewriter.json`
- **THEN** settings resolve exactly as VS Code settings alone

### Requirement: File sits between user and workspace settings
Each setting SHALL resolve, from highest to lowest priority, to its workspace setting, its value in the repository file, its user setting, then its default. Settings the file does not mention SHALL resolve as if the file did not exist. The `profiles` setting is the exception: its layers SHALL be merged by profile name, as the filter-profiles capability defines.

#### Scenario: File overrides user settings
- **WHEN** the user settings set `charsPerMinute` to 200 and the file sets it to 500, with no workspace value
- **THEN** typing uses 500 characters per minute

#### Scenario: Workspace settings override the file
- **WHEN** the file sets `include` to `["src/**"]` and the workspace settings set `include` to `["docs/**"]`
- **THEN** only files under `docs/` are recorded

#### Scenario: Reset Filters falls back to the file
- **WHEN** the workspace settings override the file's `include` and the user runs **Reset Filters**
- **THEN** the file's `include` applies

#### Scenario: Profiles from both layers
- **WHEN** the file defines profile `docs` and the workspace settings define profile `backend`
- **THEN** both `docs` and `backend` are available

### Requirement: File changes apply live
Creating, changing, or deleting the repository file SHALL take effect without a reload, the same way as changing the corresponding VS Code settings. While watching, files that newly pass the filters SHALL get a baseline so their next change is recorded.

#### Scenario: Editing the file while watching
- **WHEN** recording is on, the file's `extensions` changes from `["ts"]` to `["ts", "txt"]`, and then a `.txt` file is written
- **THEN** the `.txt` change is recorded and replayed

#### Scenario: Deleting the file
- **WHEN** the file is deleted
- **THEN** the values it set no longer apply

#### Scenario: File present at activation
- **WHEN** VS Code opens a workspace whose file sets filters and `autoStart` is on
- **THEN** the first recording session already uses the file's filters

### Requirement: Invalid content is ignored and reported
An unknown key or a value of the wrong type SHALL be ignored, and the setting SHALL resolve as if the file did not mention it; each SHALL be reported in the output channel. A file that is not a JSON object SHALL be reported with a warning, and the previous valid contents SHALL stay in effect until the file is valid again.

#### Scenario: Wrong type
- **WHEN** the file contains `{ "extensions": "ts", "charsPerMinute": 500 }`
- **THEN** `charsPerMinute` is 500, `extensions` resolves from VS Code settings, and the output channel names `extensions`

#### Scenario: Deprecated key is not unknown
- **WHEN** the file contains `{ "charsPerSecond": 10 }`
- **THEN** it is not reported as an unknown key, and the base speed follows the typing-pace fallback for `charsPerSecond`

#### Scenario: Broken JSON while editing
- **WHEN** a valid file setting `extensions` to `["md"]` is saved with a syntax error
- **THEN** a warning is shown and `extensions` stays `["md"]`

### Requirement: The extension never writes the file
The extension SHALL NOT create, modify, or delete the repository file. Opening it SHALL be offered through a command that opens the existing file, or an unsaved editor for its path prefilled with the current filter settings when it does not exist.

#### Scenario: Open when missing
- **WHEN** no file exists and the user runs **Open Repository Settings File**
- **THEN** an unsaved editor opens for `.agent-typewriter.json` in the first folder, holding the current `include`, `exclude`, and `extensions`
- **AND** no file exists on disk until the user saves it

#### Scenario: Filter commands leave the file alone
- **WHEN** the file exists and the user runs **Set Watched Extensions...**
- **THEN** the new list is written to the workspace settings and the file is unchanged
