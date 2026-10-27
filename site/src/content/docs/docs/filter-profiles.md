---
title: Filter profiles
description: "Named sets of filters you can switch between and share."
---

A profile is a named set of any of `include`, `exclude`, `extensions`, and `respectGitignore`. Define them in the [repository settings file](/docs/repository-settings/) to share them, or in the `agentTypewriter.profiles` setting:

```json
{
  "profiles": {
    "backend": { "include": ["server/**"], "extensions": ["ts"] },
    "docs": { "include": ["docs/**"], "extensions": ["md"] }
  },
  "activeProfile": "backend"
}
```

- **Switch Filter Profile...** picks a profile or "No profile". Switching clears your workspace values of the filters that profile sets, so it takes effect; other filters are left alone.
- **Save Filters as Profile...** saves the current filters under a name in workspace settings (user settings when no folder is open) and switches to it. Other saved profiles are left exactly as written.
- The active profile (`agentTypewriter.activeProfile`) overrides the repository file and user settings; workspace settings, which the filter commands write, still override it. The file can set `activeProfile` as a team default.
- Profiles with the same name merge by layer: workspace settings over the file over user settings. The panel shows the active profile's name.
