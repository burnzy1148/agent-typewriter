## MODIFIED Requirements

### Requirement: Repository settings file
The extension SHALL read settings from a file named `.agent-typewriter.json` at the root of the first workspace folder. The file SHALL be a JSON object whose keys are `agentTypewriter.*` setting names without the `agentTypewriter.` prefix, with values of the same types the settings accept. A `$schema` key SHALL be allowed and ignored. User-only settings (`hookPort`, which opens a port) SHALL NOT be read from the file.

#### Scenario: Filters from the file
- **WHEN** the file contains `{ "extensions": ["md"] }` and no VS Code setting sets `extensions`
- **THEN** only `.md` files are recorded

#### Scenario: No file
- **WHEN** the workspace has no `.agent-typewriter.json`
- **THEN** settings resolve exactly as VS Code settings alone

#### Scenario: User-only setting in the file
- **WHEN** the file contains `{ "hookPort": 47323 }` and the user settings do not set `hookPort`
- **THEN** no port is opened
- **AND** the key is reported as unknown

### Requirement: File sits between user and workspace settings
Each setting SHALL resolve, from highest to lowest priority, to its workspace setting, its value in the repository file, its user setting, then its default. Settings the file does not mention SHALL resolve as if the file did not exist. The `profiles` setting is an exception: its layers SHALL be merged by profile name, as the filter-profiles capability defines. User-only settings (`hookPort`) are another: they SHALL resolve to their user setting, then their default, ignoring the workspace setting and the file.

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

#### Scenario: User-only setting in workspace settings
- **WHEN** the workspace settings set `hookPort` to 47323 and the user settings do not set it
- **THEN** no port is opened
