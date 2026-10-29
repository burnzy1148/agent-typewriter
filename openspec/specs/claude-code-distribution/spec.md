# claude-code-distribution Specification

## Purpose

Defines how the Agent Typewriter plugin for Claude Code is published from this repository's own plugin marketplace: how users install it, which branch or tag their install follows, how new versions reach them, and the checks that keep the marketplace installable.

## Requirements

### Requirement: The repository is a plugin marketplace
The repository SHALL be a Claude Code plugin marketplace named `agent-typewriter`, with its catalog at `.claude-plugin/marketplace.json` in the repository root. The catalog SHALL list one plugin, `agent-typewriter`, whose files are the `claude-code/` folder of the same commit. It SHALL serve local Claude Code: the plugin SHALL install from it in the desktop app's local sessions, in Claude Code's VS Code extension, and with `/plugin` or `claude plugin` in a terminal.

#### Scenario: Install in one step
- **WHEN** a user of Claude Code 2.1.309 or later runs `/plugin install agent-typewriter --marketplace burnzy1148/agent-typewriter` in a session, or `claude plugin install agent-typewriter --marketplace burnzy1148/agent-typewriter` in a shell
- **THEN** the marketplace is added as `agent-typewriter` and the plugin installs as `agent-typewriter@agent-typewriter`

#### Scenario: Desktop app
- **WHEN** the `agent-typewriter` marketplace has been added and the user opens the plugin browser from the desktop app's Code tab
- **THEN** Agent Typewriter is listed there and installs from it

#### Scenario: Marketplace already added
- **WHEN** a user who added the marketplace runs `/plugin install agent-typewriter@agent-typewriter`
- **THEN** the plugin installs from that marketplace

#### Scenario: Cloud session
- **WHEN** a user who installed the plugin starts a cloud session, such as one on claude.ai/code, in the mobile app or in the desktop app's cloud sessions
- **THEN** the plugin is not loaded there, because cloud sessions load neither plugins installed on the user's machine nor those a repository's settings turn on

### Requirement: The added ref decides what is installed
The plugin SHALL come from the same commit as the catalog the user added. Without a ref, a user SHALL get the repository's default branch, `develop`. With `#<ref>`, they SHALL get that branch or tag. `main` SHALL serve released versions only.

#### Scenario: Default branch
- **WHEN** a user adds `burnzy1148/agent-typewriter` and installs the plugin
- **THEN** they get the plugin as it is at the head of `develop`

#### Scenario: Released versions only
- **WHEN** a user adds `burnzy1148/agent-typewriter#main` and installs the plugin
- **THEN** they get the plugin as of the latest stable release

#### Scenario: Testers on a branch
- **WHEN** a tester runs `/plugin install agent-typewriter --marketplace burnzy1148/agent-typewriter#claude-code-extension`
- **THEN** they get the plugin as it is at the head of `claude-code-extension`, even before that branch is merged into `develop`

### Requirement: Each commit is a plugin version
Neither the plugin's manifest nor its catalog entry SHALL set a version, so that the installed version is the commit it came from. A user SHALL be offered an update whenever the ref they added has moved to a commit that changes the plugin, and SHALL NOT be offered one while it has not moved.

#### Scenario: Fix on the testers' branch
- **WHEN** a fix merges into `claude-code-extension` and a tester who added that branch updates the marketplace
- **THEN** their plugin updates to the commit with the fix

#### Scenario: Merges between releases
- **WHEN** PRs merge into `develop` and no release has been made since a user added `#main`
- **THEN** that user is not offered an update

#### Scenario: Version shown
- **WHEN** a user lists their installed plugins
- **THEN** the plugin's version names the commit it was installed from

### Requirement: Stable releases release the plugin
The plugin SHALL have no release process, version number or tag of its own. Promoting `develop` to `main` through the Release workflow SHALL be what releases the plugin to users who added `#main`.

#### Scenario: Stable release
- **WHEN** the release PR for v0.8.0 merges into `main`
- **THEN** users who added `#main` are offered the plugin as of that release when they next update

#### Scenario: No plugin tag
- **WHEN** a stable release is made
- **THEN** no plugin-specific tag such as `agent-typewriter--v<version>` is created

### Requirement: The marketplace is checked on every change
Every pull request that changes more than the docs site SHALL validate the catalog and the plugin with a pinned Claude Code CLI, treating every warning as an error except the one asking for a version, and SHALL install the plugin from the checkout's own marketplace. A failure in either SHALL fail the check.

#### Scenario: Wrong plugin path
- **WHEN** a PR changes the catalog entry's source to a folder that does not exist
- **THEN** the install check fails and the PR's checks fail

#### Scenario: Unknown catalog field
- **WHEN** a PR adds a misspelled field to `.claude-plugin/marketplace.json`
- **THEN** validation reports it and the PR's checks fail
