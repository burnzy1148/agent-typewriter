# Spec Delta

## MODIFIED Requirements

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
