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

To try replay by hand, run `npm run tour`. It builds the extension, makes a throwaway git repository, and opens it in a VS Code window running your build in a throwaway profile. Then it acts as an agent, one scenario per Enter: new files, word changes, short and long deletions, far edits, file switching, a burst of changes, a big paste, a CRLF file, a rename and a deleted file. Each step says what to watch for. It ends with a checklist of things to try by hand: seeking, clearing highlights, settings, reload, sessions, and Replay Git Commits on the repository's `main..feature`. `--auto` runs the steps without waiting; the header of `scripts/replay-tour.mjs` lists the other options.

The README demo (`images/demo.gif`) is recorded by `node scripts/demo/record.mjs` on macOS with ffmpeg installed. It opens a throwaway VS Code profile on a copy of `scripts/demo/workspace`, lets a scripted agent edit it, and screen-records the window. The header of `record.mjs` lists options for choosing the display. Re-record it when the UI in the shot changes.

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

1. Run the **Release** workflow from the Actions tab, or `gh workflow run release.yml -f bump=patch` (or `minor`, `major`). It cuts `release/v<version>` from `develop`, bumps the version in `package.json` and `package-lock.json`, dates the CHANGELOG's `## Unreleased` heading, and opens a PR into `main`.
2. When CI is green, merge that PR with **Create a merge commit**. Don't squash, or `develop` and `main` stop sharing history.
3. The merge tags `main` `v<version>` and runs CI on the tag, which checks the tag against `package.json`, publishes the tested .vsix to the Marketplace, and creates the GitHub release. It also opens a PR syncing `main` back into `develop`. Merge that one with a merge commit too.

Without the workflow, do the same by hand: a `release/v<version>` PR from `develop` into `main` with the version bump, a merge commit, `git tag v<version>` on the merge and `git push origin v<version>`, then merge `main` into `develop`.

`scripts/apply-branch-rules.sh` sets the rulesets on `main` and `develop`: PRs only, CI green before merge, no force pushes or deletion, merge commits only on `main`. Repository admins can bypass them.

## License

By contributing, you agree that your contributions are licensed under the [MIT License](LICENSE).
