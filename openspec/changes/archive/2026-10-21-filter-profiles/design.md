# Design

## Context

After kbn.1 and kbn.3, `readSettings()` resolves each key as workspace > repository file > user > default through `pickLayer`, the file's values are validated by `parseRepoSettings` against `REPO_SETTING_KINDS`, and filter changes from either source go through `applySettingsChange` into `recorder.refreshFilter()`. Filter commands write workspace settings via `updateSetting`. The extension never writes the repository file.

## Goals / Non-Goals

**Goals:**
- Several named filter sets, shareable through the repository file and saveable from the UI.
- Switching that takes effect even when hand-made workspace filter values exist.
- No new storage: profiles and the active name are ordinary settings.

**Non-Goals:**
- Profiles for non-filter settings (speed, pacing). The four filter keys only.
- Deleting or renaming profiles from the UI. They are plain settings entries.
- Per-folder profiles in multi-root workspaces.

## Decisions

### Profiles and the active name are settings
`agentTypewriter.profiles` (object of profile objects) and `agentTypewriter.activeProfile` (string). Being settings, they work in the repository file with no new format, a team can set a default `activeProfile` there, and switching writes workspace settings like every other command. Alternative: keep the active name in `workspaceState`. It would avoid touching `.vscode/settings.json`, but it could not be defaulted from the repository file and would bypass the existing change handling.

### Layering: default < user < file < profile < workspace
A profile is a choice the user makes in this workspace, so it outranks the shared file and personal user settings. Workspace values still win so the existing commands (Watch Only This, Set Watched Extensions) work as local tweaks on top of a profile. Placing the profile above workspace was considered, but then those commands would silently do nothing while a profile is active. Implementation: for the four filter keys, `readSettings` passes `profile[key] ?? repoValues[key]` as the middle layer of `pickLayer`.

### Switching clears the workspace values the profile sets
Without this, a workspace `extensions` value left by Set Watched Extensions would hide the profile's `extensions`, and switching would look broken. Only keys the target profile sets are cleared, so unrelated hand tweaks survive. "No profile" clears nothing.

### Merge by name across layers
`profiles` is the one setting not replaced whole by a higher layer: `{ ...user, ...file, ...workspace }`. Otherwise saving one profile to workspace settings would hide every profile in the repository file.

### Validation in one pure module
`src/profiles.ts` holds `parseProfiles(raw)` (drops non-object profiles and invalid entries, returns problems), `mergeProfiles`, and `activeProfileOf(settings)`. `parseRepoSettings` uses it for the file's `profiles` key and reports its problems; `readSettings` uses it silently for VS Code settings, which VS Code's own schema check already flags in the editor. `REPO_SETTING_KINDS` gains `string` (for `activeProfile`) and `profiles` kinds.

### Commands take an optional argument
**Switch Filter Profile...** and **Save Filters as Profile...** accept a name argument that skips the picker or input box. That keeps them scriptable from keybindings and lets the integration tests drive them.

### Unknown names
`Settings` carries the raw `activeProfile` and the merged `profiles`. When the name is not found, filters resolve without a profile, `describeFilter` shows no name, and `applySettingsChange` logs the unknown name once per change of either setting.

## Risks / Trade-offs

- [Switching rewrites workspace filter values the user set by hand] → Only for keys the target profile sets; the README says so.
- [Several config writes per switch cause several filter refreshes] → Same as Reset Filters today; each refresh is incremental.
- [A workspace value hides a profile value after switching] → Possible only if a filter command runs after the switch, which is the intended local-tweak behavior.
