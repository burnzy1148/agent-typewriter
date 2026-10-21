# Spec Delta

## MODIFIED Requirements

### Requirement: File sits between user and workspace settings
Each setting SHALL resolve, from highest to lowest priority, to its workspace setting, its value in the repository file, its user setting, then its default. Settings the file does not mention SHALL resolve as if the file did not exist. The `profiles` setting is the exception: its layers SHALL be merged by profile name, as the filter-profiles capability defines.

#### Scenario: File overrides user settings
- **WHEN** the user settings set `charsPerSecond` to 20 and the file sets it to 50, with no workspace value
- **THEN** typing uses 50 characters per second

#### Scenario: Workspace settings override the file
- **WHEN** the file sets `include` to `["src/**"]` and the workspace settings set `include` to `["docs/**"]`
- **THEN** only files under `docs/` are recorded

#### Scenario: Reset Filters falls back to the file
- **WHEN** the workspace settings override the file's `include` and the user runs **Reset Filters**
- **THEN** the file's `include` applies

#### Scenario: Profiles from both layers
- **WHEN** the file defines profile `docs` and the workspace settings define profile `backend`
- **THEN** both `docs` and `backend` are available
