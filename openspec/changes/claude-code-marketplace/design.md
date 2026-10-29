# Design

## Context

How Claude Code installs from a marketplace (as of 2.1.309, which the plugin already requires):

- `/plugin marketplace add owner/repo` clones the repository's default branch and reads `.claude-plugin/marketplace.json`. `owner/repo#ref` (or `@ref`) clones that branch or tag instead. `/plugin install <name> --marketplace <source>` adds the marketplace and installs in one step (2.1.275 and later).
- A catalog entry's `source` may be a relative path such as `./claude-code`, resolved inside the same clone, or a remote source (`github`, `git-subdir`, `url`, `archive`, `npm`) with its own `ref` and `sha`.
- A user is offered an update only when the plugin's computed version changes. That version is `plugin.json`'s `version`, else the catalog entry's, else, for a relative path in a git-hosted marketplace, the commit it was installed from. A pinned `version` keeps everyone on their cached copy until the string changes, however many commits land.
- A user can register only one marketplace per name. Auto-update is off for third-party marketplaces until the user turns it on; without it, users update with `/plugin marketplace update` or `claude plugin update`.
- The terminal, the desktop app's local sessions and the VS Code extension read the same settings, so a marketplace added in one is available in the others. The desktop app's plugin browser (**+** → **Add plugins**) lists plugins from added marketplaces.

The repository's default branch is `develop`. `main` only moves when the Release workflow's `release/v<version>` PR merges. `claude-code/` exists only on `claude-code-extension` until that branch is merged into `develop`. `plugin.json` says `0.1.0`, which was never published. The VS Code extension has its own channels (`release-publishing`); the `.vsix` ships an allow-list of files, so new root files do not reach it.

## Goals / Non-Goals

**Goals:**
- One catalog that works unchanged on every branch and tag: whatever ref a user adds, the plugin they get is the code of that ref.
- Testers on a branch receive every fix pushed to it, without reinstalling.
- No second release process to maintain beside the extension's.

**Non-Goals:**
- Readable plugin version numbers, release notes per plugin version, or `<plugin>--v<version>` tags for dependency ranges. Nothing depends on this plugin.
- Making `burnzy1148/agent-typewriter` without a ref serve released versions while the default branch is `develop`.

## Decisions

### The catalog lists the plugin by relative path

```json
{ "name": "agent-typewriter", "source": "./claude-code" }
```

The plugin comes from the same clone as the catalog, so the ref the user adds decides both. The catalog is identical on `develop`, `main` and every feature branch, and merges never have to rewrite it.

Alternative: a `git-subdir` source pinned to a release tag, which the Release workflow's bump PR would update. That makes the default branch serve releases, but a catalog on any other branch would then install the pinned release rather than that branch's code, so testers could not install from `claude-code-extension`. It also adds a file the bump job edits. Rejected for now; it can be revisited if the default must serve releases once the plugin leaves early access.

Alternative: two marketplaces (`agent-typewriter` and `agent-typewriter-latest`) with entries on different refs, as Claude Code's docs suggest for channels. `owner/repo` only reads `.claude-plugin/marketplace.json`, so a second catalog in this repository would need users to edit settings. Rejected.

The catalog sets no display fields of its own. For a relative-path entry Claude Code reads `plugin.json` before install, so the description, author and homepage stay in one place.

### Channels are refs

| User adds | Gets | Moves when |
| --- | --- | --- |
| `burnzy1148/agent-typewriter` | `develop` | any PR merges into `develop` |
| `burnzy1148/agent-typewriter#main` | the latest stable release | a release PR merges into `main` |
| `burnzy1148/agent-typewriter#claude-code-extension` | the plugin's integration branch | a PR merges into it |

The unpinned command is the one the README leads with, because it is the shortest and the plugin is early access anyway: users who install an early-access plugin want fixes as they land, as testers on `develop` pre-releases of the extension do. `#main` is documented for users who want only released versions. Until `claude-code-extension` merges into `develop`, the unpinned command finds no catalog, and the docs point testers at the branch.

Any other branch or tag that has the catalog works the same way, so a reviewer can install a PR's branch to try it. Tags from before the plugin existed have no catalog and fail to add.

Switching channels means removing the marketplace (which uninstalls the plugin) and adding the other ref, because both register under the same name. The docs say so.

### No version field: the commit is the version

`plugin.json` drops `"version": "0.1.0"` and the catalog entry sets none, so the installed version is the commit (shown shortened in `claude plugin list`). Every ref then behaves like its channel: a tester on `claude-code-extension` gets each merge on update, a `#main` user gets nothing until the next release, and a bug report names the exact commit.

Alternative: the extension's version in `plugin.json`, bumped by the Release workflow with `package.json`. Users on `develop` or a branch would keep whatever commit they first installed until the next release, and two users showing 0.8.0 could run different code. Rejected.

Alternative: an independent semver with `claude plugin tag` releases. A second version stream, changelog and workflow for a plugin that shares its core with the extension and ships from the same branches. Rejected.

### Releases ride the extension's release

The Release workflow is unchanged. Promoting `develop` to `main` releases the plugin to `#main` users; `develop` users already have it. The extension's CHANGELOG and GitHub release cover plugin changes, so when `claude-code-extension` merges into `develop` its CHANGELOG entry should mention the plugin.

### One script runs the plugin checks

`npm run check:claude-code` runs a new `scripts/check-claude-code.mjs`, which keeps the pinned CLI version in one place and runs, in order:

1. `plugin validate . --strict`: the catalog, and the manifest of the plugin it lists.
2. `plugin validate claude-code --strict`: the manifest, hooks module and state contract.
3. `plugin test claude-code`: the plugin's tests, as before.
4. An install check: with `CLAUDE_CONFIG_DIR` set to a fresh temporary folder, `plugin marketplace add <checkout>` and `plugin install agent-typewriter@agent-typewriter`, then a check that `plugin list --json` shows it installed from the checkout. Validation passes a relative source that points at a missing folder; only an install catches it. The temporary folder keeps the developer's own Claude Code settings untouched, and none of these commands need a login.

`--strict` turns warnings such as unknown catalog fields into failures. The plugin-directory profile (`--profile directory`) stays out: it asks for an icon, which belongs to at-o3z.9. The CI job keeps running `npm run check:claude-code`, so its steps only change name.

## Risks / Trade-offs

- [The unpinned command serves `develop`, not releases] → The README names `#main` for released versions, and the table above is in `CONTRIBUTING.md`. Revisit before the official directory listing (at-o3z.9), which may want a pinned source.
- [Versions are commit hashes, not numbers] → Bug reports are more precise; the GitHub release for a stable version still lists what changed.
- [A `develop` merge that changes only the site or the extension may still count as a new plugin version] → The update is identical files; users see an update notice at most. Verified against the real behavior while applying, and noted in the docs if it happens.
- [Claude Code's marketplace behavior changes, as early-access features may] → The CLI is pinned in CI, and the install check fails visibly when the pin is bumped and behavior differs.
- [The testers' branch note goes stale once `claude-code-extension` merges into `develop`] → A follow-up bead tracks removing it, with the CHANGELOG entry, at that merge.

## Migration Plan

Nothing is installed from a marketplace yet, so there is nothing to migrate. Testers who used `--plugin-dir` can keep doing so; a `--plugin-dir` copy takes precedence over an installed one with the same name for that session.
