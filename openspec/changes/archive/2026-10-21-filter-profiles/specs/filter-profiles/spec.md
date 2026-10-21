# Spec Delta

## Purpose

Lets users keep several named filter sets, such as backend-only or docs-only, and switch between them without re-entering globs.

## ADDED Requirements

### Requirement: Profiles define filter sets
A profile SHALL be a name mapped to an object holding any of `include`, `exclude`, `extensions`, and `respectGitignore`, with the same value types as those settings. Profiles SHALL be read from the `profiles` key of the repository settings file and from the `agentTypewriter.profiles` setting. Invalid entries within a profile SHALL be ignored, and the rest of the profile SHALL still apply.

#### Scenario: Profile in the repository file
- **WHEN** the file contains `{ "profiles": { "docs": { "include": ["docs/**"], "extensions": ["md"] } } }`
- **THEN** a profile named `docs` is available

#### Scenario: Invalid entry in a profile
- **WHEN** a profile sets `extensions` to `"md"` and `include` to `["docs/**"]`
- **THEN** activating it applies its `include` and leaves `extensions` as it resolves without the profile

### Requirement: Profiles merge by name
Profiles from user settings, the repository file, and workspace settings SHALL be combined by name. When the same name appears in more than one layer, the workspace settings' profile SHALL replace the file's, and the file's SHALL replace the user settings'.

#### Scenario: Same name in two layers
- **WHEN** the file's `docs` profile sets `include` to `["docs/**"]` and the workspace settings' `docs` profile sets `include` to `["site/**"]`
- **THEN** activating `docs` records only files under `site/`

### Requirement: Active profile sits above the file
The setting `agentTypewriter.activeProfile` SHALL name the active profile; `""`, the default, means none. For each filter setting the active profile sets, that value SHALL resolve above the repository file and user settings and below workspace settings. Filter settings it does not set, and all other settings, SHALL resolve as without a profile.

#### Scenario: Profile overrides the file
- **WHEN** the file sets `include` to `["**/*"]`, the active profile sets `include` to `["docs/**"]`, and no workspace value is set
- **THEN** only files under `docs/` are recorded

#### Scenario: Workspace value overrides the profile
- **WHEN** the active profile sets `extensions` to `["md"]` and the workspace settings set `extensions` to `["ts"]`
- **THEN** only `.ts` files are recorded

#### Scenario: Unknown profile name
- **WHEN** `activeProfile` names a profile that does not exist
- **THEN** filters resolve as with no profile
- **AND** the output channel reports the unknown name

### Requirement: Switching profiles
The **Switch Filter Profile...** command SHALL list every available profile and a "No profile" choice. Picking a profile SHALL set `activeProfile` in workspace settings and clear workspace values of the filter settings that profile sets, so the profile takes effect. Picking "No profile" SHALL set `activeProfile` to `""` and leave other settings as they are. The change SHALL apply while recording, like any filter change.

#### Scenario: Switch while watching
- **WHEN** recording is on, the workspace settings set `extensions` to `["ts"]`, and the user switches to a profile whose `extensions` is `["md"]`
- **THEN** the workspace `extensions` value is cleared
- **AND** the next `.md` change is recorded and the next `.ts` change is not

#### Scenario: Back to no profile
- **WHEN** a profile is active and the user picks "No profile"
- **THEN** filters resolve as without a profile

### Requirement: Saving the current filters as a profile
The **Save Filters as Profile...** command SHALL ask for a name, store the current effective `include`, `exclude`, `extensions`, and `respectGitignore` under that name in the workspace settings' `agentTypewriter.profiles`, and make it the active profile. Saving under an existing workspace profile's name SHALL replace it after confirmation. The repository file SHALL NOT be written.

#### Scenario: Save and reuse
- **WHEN** the user narrows filters with **Watch Only This** on `docs/` and saves them as `docs`
- **THEN** the workspace settings' `profiles` contain `docs` with `include` `["docs/**"]`
- **AND** `docs` is the active profile

### Requirement: The active profile is shown
While a profile is active, the panel's description and the status bar tooltip SHALL include its name.

#### Scenario: Name in the panel
- **WHEN** profile `docs` is active and recording is on
- **THEN** the Agent Typewriter panel's description starts with `docs`
