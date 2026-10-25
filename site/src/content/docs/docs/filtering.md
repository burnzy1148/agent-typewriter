---
title: Filters
description: "Choose which files are recorded with extension, include and exclude filters and .gitignore."
---

Three settings combine. A path must pass all of them:

| Setting | Default | Meaning |
|---|---|---|
| `agentTypewriter.extensions` | `[]` (any) | Allow-list of extensions, e.g. `["ts", "java", "md"]` |
| `agentTypewriter.include` | `["**/*"]` | Workspace-relative globs. A pattern without `/` (like `*.ts`) matches the file name anywhere |
| `agentTypewriter.exclude` | `.git`, `node_modules`, `dist`, `out`, `build`, `target`, lock files, logs | Exclude always wins |
| `agentTypewriter.respectGitignore` | `false` | Also skip paths git ignores |

Shortcuts:

- **Set Watched Extensions...** prompts for a list like `ts tsx java`.
- Right-click files or folders in the Explorer: **Watch Only This** replaces the include list with your selection; **Add to Watch Filter** adds to it.
- **Reset Filters** restores the defaults.

Filter changes apply immediately while watching; newly matching files are snapshotted right away. To share filters with everyone who opens a repository, use the [repository settings file](/docs/repository-settings/); to switch between named sets of filters, use [filter profiles](/docs/filter-profiles/).

With `respectGitignore` on, anything git would ignore as an untracked file is skipped: `.gitignore` files at every level, `.git/info/exclude`, and your global excludes file. Files git tracks are recorded even if they match an ignore pattern, as in git. Edits to `.gitignore` apply while watching; changes to `.git/info/exclude` or the global file apply at the next start or filter change. Without git, or outside a repository, the setting does nothing and the output channel says so. With it on, the default `exclude` list is mostly redundant in a typical repository.
