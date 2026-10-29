# Contributing

Thanks for helping with Agent Typewriter. Bug reports, ideas, and pull requests are all welcome.

## Reporting bugs

Open a [GitHub issue](https://github.com/burnzy1148/agent-typewriter/issues) with:

- your OS and VS Code version,
- what wrote the files (Claude Code in a terminal, the Claude Code VS Code extension, another agent, a script),
- what you expected to see replayed and what you saw,
- anything relevant from the **Agent Typewriter** output channel.

## Setup

You need Node.js 22 (what CI uses) and VS Code.

```
npm install
npm test          # unit tests plus a fuzz test of the diff planner
npm run it        # integration tests in a real headless VS Code
npm run package   # typecheck, test, bundle, produce the .vsix
```

`npm run it` downloads a VS Code build into `.vscode-test/` on first run. On Linux without a display it runs itself under `xvfb-run`, so install xvfb first. To run only some of its launches, as CI does in parallel jobs, set `IT_GROUP` to a comma-separated list: `recording`, `playback`, `reload` or `edits` for one part of `it/suite.ts`, `suite` for all of it in one launch, and `workspaces` for the launches with workspaces of their own.

Run `npm run build` (or keep `npm run watch` running), then press F5 with the folder open to launch an Extension Development Host with your build loaded.

To try replay by hand, run `npm run tour`. It builds the extension, makes a throwaway git repository, and opens it in a VS Code window running your build in a throwaway profile. Then it acts as an agent, one scenario per Enter: new files, word changes, short and long deletions, far edits, file switching, a burst of changes, a big paste, a CRLF file, a rename and a deleted file, then two git worktrees with an agent in each, recorded in separate lanes that auto-follow plays one after the other. Each step says what to watch for. It ends with a checklist of things to try by hand: seeking, clearing highlights, settings, reload, sessions, Replay Git Commits on the repository's `main..feature`, and following and unticking lanes in the Checkouts view. `--auto` runs the steps without waiting; the header of `scripts/replay-tour.mjs` lists the other options.

The README demo (`images/demo.gif`) is recorded by `npm run demo` on macOS with ffmpeg installed. It plays the tour's lane steps (defined once in `scripts/tour-scenarios.mjs`) into the tour's repository in a throwaway VS Code profile and screen-records the window: two worktrees get their own lanes, and playback follows one and then the other. The header of `scripts/demo/record.mjs` lists options for choosing the display, and its `shot` list picks the steps. `npm run demo -- --dry-run` plays the shot without recording and prints when each lane was followed and typed, to check the timing first. Re-record it when the UI in the shot changes.

## The docs site

The site at [agent-typewriter.com](https://agent-typewriter.com) is built from `site/` with [Astro](https://astro.build) and [Starlight](https://starlight.astro.build). It is a separate npm project, so its dependencies never touch the extension's.

```
cd site
npm install
npm run dev       # live preview at http://localhost:4321
npm run build     # static build in site/dist, fails on broken internal links
```

- Docs pages are Markdown files in `site/src/content/docs/docs/`, and the sidebar order is in `site/astro.config.mjs`. Every page has an "Edit this page" link to its file.
- The settings reference is generated from `contributes.configuration` in the root `package.json`, so a new setting needs no docs edit. Describe it well in `package.json` instead.
- The demo GIF, banner and icon are copied from `images/` at build time. Don't add copies under `site/`. The banner is also the preview image when a site link is shared.
- PRs that change the site get a build check. PRs from branches in this repository also get a preview link posted on the PR; PRs from forks and Dependabot PRs don't, because their runs can't read the deploy secret. A PR that only changes `site/` skips the extension's tests.
- Production follows releases: the site deploys when a release merges into `main`, so it always describes the published version.

## The Claude Code plugin

`claude-code/` is a Claude Code plugin that replays the edits a Claude Code session makes, in a pane beside the conversation. It is built on Claude Code's early-access function-hooks API: `hooks/register.tsx` hooks the `Edit` and `Write` tool calls and draws the pane, and `hooks/replay.ts` is its playback logic. It shares the diff planner and typing logic with the extension through `hooks/core.mjs`, a committed bundle of `src/planner.ts` and `src/typingChunks.ts`.

```
npm run build:claude-code      # rebuild hooks/core.mjs after changing the shared modules; commit it
npm run check:claude-code      # validate the marketplace and the plugin, run its tests, install it (pinned Claude Code CLI)
npm run typecheck:claude-code  # type-check it against the engine's types (see below)
claude --plugin-dir claude-code
```

The last line starts a Claude Code session with your working copy loaded. Ask Claude to edit a file and the pane types it out. Saving a file in `claude-code/` reloads the plugin in that session.

The replay logic's unit tests run in `npm test`. The plugin's own tests (`claude-code/tests/`) run under `claude plugin test`, which `check:claude-code` calls. `check:claude-code` (`scripts/check-claude-code.mjs`) also validates the marketplace catalog, failing on any warning about the catalog, the manifest or the plugin's contents except the plugin's missing version, and on a version being set (see below); the plugin-directory checks, such as the icon, are left to the directory submission. It then installs the plugin from your checkout's marketplace, which catches a catalog entry that points at a missing folder. It runs the CLI with a temporary `CLAUDE_CONFIG_DIR`, so your own Claude Code settings are left alone. Type-checking needs the engine's types in `claude-code/.claude-plugin/types/`, which Claude Code writes (and ignores in git) when a session loads the plugin from your folder, so run the plugin once with `--plugin-dir` first. CI cannot do that, so it runs the bundle check, validation, tests and install but not the type check.

**The marketplace.** `.claude-plugin/marketplace.json` makes the repository a Claude Code plugin marketplace named `agent-typewriter`, listing `claude-code/` by relative path. Claude Code clones the branch or tag a user adds and installs the plugin from that same clone, so branches are the plugin's channels:

| User adds | Gets | Moves when |
| --- | --- | --- |
| `burnzy1148/agent-typewriter` | `develop`, the default branch | a PR merges into `develop` |
| `burnzy1148/agent-typewriter#main` | the latest stable release | a release PR merges into `main` |
| `burnzy1148/agent-typewriter#<branch>` | that branch | a commit is pushed to it |

The marketplace reaches local Claude Code only: the desktop app's local sessions, Claude Code's VS Code extension and the terminal, which share the marketplaces a user adds. The plugin is made for the desktop app and the VS Code extension; people who run Claude Code in a terminal replay with the Agent Typewriter VS Code extension instead. Cloud sessions (claude.ai/code, the mobile app, the desktop app's cloud sessions, `claude --cloud`) have no `/plugin` and load neither plugins installed on the user's machine nor those a repository's `.claude/settings.json` turns on, so the plugin doesn't run there yet.

`plugin.json` sets no `version`, so Claude Code versions the plugin by the commit it installed from, and users get each new commit on their branch when they update (any commit, even one outside `claude-code/`). Don't add a `version`: users would then stay on the commit they first installed until someone changed it. The validator warns about the missing version, and `check:claude-code` allows that one warning and fails if `plugin.json` or the catalog entry sets a version.

**Testing a branch.** Push it, then from a shell:

```bash
claude plugin install agent-typewriter --marketplace burnzy1148/agent-typewriter#<branch>
```

If the `agent-typewriter` marketplace is already added from another branch, run `claude plugin marketplace remove agent-typewriter` first. To pick up later pushes, run `claude plugin marketplace update agent-typewriter`, then `claude plugin update agent-typewriter@agent-typewriter`. Until `claude-code-extension` is merged into `develop`, testers install from `#claude-code-extension`. To keep a test install away from your own Claude Code setup, run the `claude plugin` commands from a shell with `CLAUDE_CONFIG_DIR` set to an empty folder, as `scripts/check-claude-code.mjs` does.

**Releases.** The plugin has no release, version number or tag of its own. The Release workflow's promotion of `develop` to `main` is what releases it to `#main` users, and the CHANGELOG and the GitHub release cover its changes along with the extension's.

## How the code fits together

[CLAUDE.md](CLAUDE.md) describes the main modules in `src/` and the rules that must not break. The two most important:

- The extension never writes to the user's real files. Replay only happens in `agent-typewriter:` mirror documents.
- Applying the planner's hunks to a change's before text must reproduce its after text exactly. The fuzz test in `test/` guards this; keep it passing.

## Proposing changes

Small fixes can go straight to a pull request.

Features and changes to specified behavior are written up first as an [OpenSpec](https://github.com/Fission-AI/OpenSpec) change under `openspec/changes/<name>/` (proposal, design, spec deltas, tasks). The current behavior is specified in `openspec/specs/`, and `openspec/changes/archive/` shows how earlier changes were written. If you use Claude Code, the `/opsx:*` commands in `.claude/` walk through propose, apply, and archive. Opening an issue to discuss a larger idea before writing the change is also fine.

## Pull requests

- Branch from `develop` and open the PR against `develop`, the default branch. `main` only receives releases.
- Add or update tests for the behavior you change. Integration tests live in `it/`, unit tests in `test/`.
- CI runs typecheck, unit tests, and integration tests on Ubuntu and Windows, and packages the `.vsix`, all in parallel jobs. It must be green before merge. After a merge it also runs all of `it/suite.ts` in one launch on Ubuntu, and a release waits for that.
- If the PR implements an OpenSpec change, archive the change on the branch once its tasks are done, so the updated specs land with the code.
- Add a line under `## Unreleased` at the top of [CHANGELOG.md](CHANGELOG.md) for user-visible changes. Add that heading if the top section is already a released version.
- Feature PRs are squash-merged into `develop`.

## Releasing (maintainers)

1. Run the **Release** workflow from the Actions tab, or `gh workflow run release.yml -f bump=patch` (or `minor`, `major`). It cuts `bump/v<version>` from `develop`, bumps the version in `package.json` and `package-lock.json`, dates the CHANGELOG's `## Unreleased` heading, and opens a PR into `develop`. Stable versions keep even minors, because pre-releases use the odd minor above them, so `minor` goes to the next even minor above the pre-release stream: 0.3.0 becomes 0.6.0, and 0.6.2 becomes 0.8.0. `patch` and `major` work as npm's do.
2. When CI is green, merge that PR. The merge tags the resulting `develop` commit `v<version>`, points `release/v<version>` at it, and opens a PR into `main`.
3. When CI is green, merge the release PR with **Create a merge commit**. Don't squash, and don't push to `release/v<version>`: the tag must stay on its head. The merge runs CI on the tag, which checks the tag against `package.json`, publishes the tested .vsix to the Marketplace, and creates the GitHub release.

Merging the release PR also releases the Claude Code plugin to users who installed it from `#main` (see [The Claude Code plugin](#the-claude-code-plugin)).

The tag lives in `develop`'s history, so nothing has to be synced back from `main`. Pushing a `v*` tag doesn't publish anything. Only a CI run dispatched on the tag does, which the workflow starts after step 3.

If the release PR is closed without merging, the bump and the tag stay on `develop`. To release that commit after all, reopen the PR. To release a later `develop` commit as the same version instead, for example after a fix, move the tag and the branch to it and open the PR again:

```
git fetch origin
git tag -f v<version> origin/develop
git push -f origin v<version>
git push -f origin origin/develop:refs/heads/release/v<version>
gh pr create --base main --head release/v<version> --title "Release v<version>"
```

If a workflow run fails partway, rerun it: each job skips the tag, branch, or PR it already created.

Without the workflow, do the same by hand: a PR into `develop` with the version bump (`node scripts/version-cli.mjs next-stable minor` prints the version a bump gives), `git tag v<version>` on its merge and `git push origin v<version>`, a `release/v<version>` PR from that commit into `main` merged with a merge commit, then `gh workflow run ci.yml --ref v<version>` to publish.

`scripts/apply-branch-rules.sh` sets the rulesets on `main` and `develop`: PRs only, CI green before merge, no force pushes or deletion, merge commits only on `main`. Repository admins can bypass them.

## Pre-releases (maintainers)

Testers who choose "Switch to Pre-Release Version" on the Marketplace get builds of `develop`. Stable users never do.

**Tags are automatic.** When a push to `develop` that changes the extension passes CI, the `prerelease-tag` job tags it `pre-v<version>`. The version is the stable version's major, the first odd minor above its minor, and a count that goes up by one per tag. After 0.3.0, that's 0.5.0, 0.5.1, and so on, and after a release of 0.6.0 it's 0.7.0. `package.json` keeps the stable version. These get no tag:
- the version-bump merge
- a site-only push
- a failed run
- a commit older than the newest tag

A merge whose run is cancelled by a newer push gets no tag of its own; the next tag includes it. Tags are never deleted.

**Publishing is manual.** Run the **Pre-release** workflow from the Actions tab, or:

```
gh workflow run prerelease.yml                      # the newest pre-v tag on develop
gh workflow run prerelease.yml -f tag=pre-v0.5.3    # a chosen one
```

It builds the tagged commit with that version and the pre-release flag, publishes it, and creates a GitHub release marked pre-release with the `.vsix`. Then it removes all but the newest 2 pre-releases from the Marketplace and from GitHub releases. It never removes stable versions or tags.

It refuses, without publishing:
- a tag that isn't `pre-v*`
- a tag whose commit isn't on `develop`
- a version that isn't higher than everything on the Marketplace, because testers would never be offered it (for example, after a stable release has overtaken it)

If a run fails partway, rerun it. A rerun picks the same tag, even if CI has tagged newer merges since. It finishes the steps that didn't complete and doesn't publish the version twice.

To see what's on the Marketplace, or what pruning would remove:

```
node scripts/marketplace.mjs versions
node scripts/marketplace.mjs prune --keep 2 --dry-run
```

To remove every pre-release, for example to stop offering them, remove them from both places. The tags stay.

```
VSCE_PAT=<token> node scripts/marketplace.mjs prune --keep 0
gh release list --limit 100 --json tagName,isPrerelease --jq '.[] | select(.isPrerelease and (.tagName | startswith("pre-v"))) | .tagName' | while read -r tag; do gh release delete "$tag" --yes; done
```

The first command removes them from the Marketplace and needs a Marketplace token that can publish. The second deletes the GitHub pre-releases. Keep the even-minor rule afterwards, so the next stable release still sorts above the pre-releases testers have installed.

## License

By contributing, you agree that your contributions are licensed under the [MIT License](LICENSE).
