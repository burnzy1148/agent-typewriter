---
title: Repository settings file
description: "Commit .agent-typewriter.json to share filters and settings with everyone who opens a repository."
---

To share filters (or any other setting) with everyone who opens a repository, commit a `.agent-typewriter.json` at the root of the workspace folder. Keys are the setting names without the `agentTypewriter.` prefix:

```json
{
  "include": ["src/**", "docs/**"],
  "exclude": ["**/generated/**", "**/node_modules/**"],
  "extensions": ["ts", "md"],
  "charsPerMinute": 1000
}
```

- Order, highest first: workspace settings, this file, user settings, defaults. So the file overrides your personal settings, and the [filter commands](/docs/filtering/) (which write workspace settings) still override the file locally. **Reset Filters** clears those workspace values, so the file's filters apply again.
- Edits to the file apply immediately, like a settings change. Deleting it removes its values.
- Unknown keys and values of the wrong type are ignored and listed in the **Agent Typewriter** output channel. If a save leaves the file broken JSON, its previous values stay in effect until it is fixed.
- **Open Repository Settings File** (in the panel's `...` menu) opens the file, or, if there is none, an unsaved editor prefilled with your current filters. The extension never writes the file itself; save it to create it.
- In a multi-root workspace, only the first folder's file is read.
