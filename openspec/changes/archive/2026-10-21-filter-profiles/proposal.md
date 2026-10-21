# Proposal

## Why

Moving between "watch the backend", "watch the docs", and "watch everything" today means re-entering globs and extensions by hand each time. A repository with a settings file (`.agent-typewriter.json`) can share one filter set, but not several (bead at-kbn.4).

## What Changes

- Named filter profiles. A profile is a name plus any of the filter settings `include`, `exclude`, `extensions`, and `respectGitignore`.
- Profiles come from the repository settings file's new `profiles` key and from a new `agentTypewriter.profiles` setting, merged by name. For the same name, workspace settings win over the file, and the file wins over user settings.
- New setting `agentTypewriter.activeProfile` (default `""`, no profile) chooses the active profile. The repository file may set it, for a team default.
- An active profile's filters sit above the repository file and below workspace settings. Filter settings the profile does not mention resolve as before, and the existing filter commands still override it locally.
- New command **Switch Filter Profile...**: a quick pick of profiles plus "No profile". Picking one sets `activeProfile` in workspace settings and clears workspace values of the filters that profile sets, so it takes effect.
- New command **Save Filters as Profile...**: asks for a name, saves the current effective filters as a profile in workspace settings, and makes it active.
- The panel's description and status bar tooltip show the active profile's name. An `activeProfile` naming no known profile is ignored and reported in the output channel.
- Switching applies live, like any filter change.

## Capabilities

### New Capabilities
- `filter-profiles`: defining, merging, activating, and saving named filter sets.

### Modified Capabilities
- `repo-settings`: the file accepts the `profiles` key, whose shape is validated entry by entry.

## Impact

- New `src/profiles.ts`: pure validation, merging by name, and resolution of the active profile, unit-tested.
- `src/repoSettings.ts`: validates `profiles` and `activeProfile`.
- `src/config.ts`: filter keys resolve through the active profile; `Settings` gains the resolved profile name.
- `src/extension.ts`: the two commands, profile name in status, `profiles`/`activeProfile` changes refresh filters.
- `src/recorder.ts`: `describeFilter` includes the profile name.
- `package.json`, `schemas/agent-typewriter.schema.json`: two settings, two commands, menu entries.
- README: a Profiles section.
- An integration section for switching and saving.
