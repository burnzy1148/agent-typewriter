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

`npm run it` downloads a VS Code build into `.vscode-test/` on first run. On Linux without a display it runs itself under `xvfb-run`, so install xvfb first.

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
- CI runs typecheck, unit tests, and integration tests on Ubuntu and Windows, then packages the `.vsix`. It must be green before merge.
- If the PR implements an OpenSpec change, archive the change on the branch once its tasks are done, so the updated specs land with the code.
- Add a line under `## Unreleased` at the top of [CHANGELOG.md](CHANGELOG.md) for user-visible changes. Add that heading if the top section is already a released version.
- Feature PRs are squash-merged into `develop`.

## Releasing (maintainers)

1. Run the **Release** workflow from the Actions tab, or `gh workflow run release.yml -f bump=patch` (or `minor`, `major`). It cuts `bump/v<version>` from `develop`, bumps the version in `package.json` and `package-lock.json`, dates the CHANGELOG's `## Unreleased` heading, and opens a PR into `develop`.
2. When CI is green, merge that PR. The merge tags the resulting `develop` commit `v<version>`, points `release/v<version>` at it, and opens a PR into `main`.
3. When CI is green, merge the release PR with **Create a merge commit**. Don't squash, and don't push to `release/v<version>`: the tag must stay on its head. The merge runs CI on the tag, which checks the tag against `package.json`, publishes the tested .vsix to the Marketplace, and creates the GitHub release.

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

Without the workflow, do the same by hand: a PR into `develop` with the version bump, `git tag v<version>` on its merge and `git push origin v<version>`, a `release/v<version>` PR from that commit into `main` merged with a merge commit, then `gh workflow run ci.yml --ref v<version>` to publish.

`scripts/apply-branch-rules.sh` sets the rulesets on `main` and `develop`: PRs only, CI green before merge, no force pushes or deletion, merge commits only on `main`. Repository admins can bypass them.

## License

By contributing, you agree that your contributions are licensed under the [MIT License](LICENSE).
