# Proposal

## Why

The Claude Code plugin in `claude-code/` can only be tried today by cloning the repository and starting `claude --plugin-dir claude-code`. Testers need to install it the way they install any plugin, from a terminal session or the desktop app, and keep receiving fixes. Claude Code installs plugins from marketplaces, and a GitHub repository with a `.claude-plugin/marketplace.json` at its root is one, so this repository can serve its own plugin without a separate host.

## What Changes

- **The repository becomes a plugin marketplace** named `agent-typewriter`, with `.claude-plugin/marketplace.json` at its root listing one plugin, `agent-typewriter`, whose files are `claude-code/` in the same commit. One command installs it in a local session (the terminal, the desktop app's local sessions or the VS Code extension): `/plugin install agent-typewriter --marketplace burnzy1148/agent-typewriter`. After that, the desktop app's plugin browser lists it too.
- **The ref a user adds is their channel.** Without a ref they get the default branch, `develop`. `#main` gets released versions only. `#<branch>` gets a branch, which is how testers install from `claude-code-extension` before it reaches `develop`.
- **Each commit is a plugin version.** `plugin.json` drops its `version` (0.1.0, never published), so Claude Code versions the plugin by commit and users of a ref receive every new commit on that ref when they update.
- **Releases need no new workflow.** The Release workflow already promotes `develop` to `main`, and that promotion is the plugin's release for `#main` users. The plugin gets no version number or tag of its own.
- **Checks.** `npm run check:claude-code`, which CI runs, also validates the marketplace and installs the plugin from the checkout's marketplace with the pinned CLI.
- **Docs.** `claude-code/README.md` says how to install, choose a channel, update, and switch; `CONTRIBUTING.md` says how the marketplace is served, tested from a branch, and released.

Out of scope:
- Submitting the plugin to the official plugin directory (at-o3z.9), including the icon its validator asks for.
- A version number for the plugin, or channels served as separate marketplaces.
- The docs site.
- Cloud sessions, which do not load marketplace plugins. Finding a route there is spike at-o3z.10.

## Capabilities

### New Capabilities

- `claude-code-distribution`: how the Claude Code plugin is published from this repository's marketplace, which ref a user's install follows, how versions and updates reach them, and the checks that guard the marketplace.

### Modified Capabilities

None. `claude-code-replay` describes what the plugin does once installed and does not change, and `release-publishing` (the VS Code extension's channels) keeps its requirements.

## Impact

- New `.claude-plugin/marketplace.json` at the repository root. The `.vsix` already ships only an allow-list of files, so it is unaffected.
- `claude-code/.claude-plugin/plugin.json`: no `version`.
- `package.json`'s `check:claude-code` and a new script under `scripts/` that runs the pinned CLI's checks and the install check; the CI job runs it as before.
- `claude-code/README.md`, `CONTRIBUTING.md`, `CLAUDE.md`.
- Users and testers need Claude Code 2.1.309 or later, as the plugin already does. One-step install (`--marketplace`) needs 2.1.275, which that covers.
- Until `claude-code-extension` merges into `develop`, the default command finds no marketplace; testers add the branch instead.
