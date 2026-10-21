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

## How the code fits together

[CLAUDE.md](CLAUDE.md) describes the main modules in `src/` and the rules that must not break. The two most important:

- The extension never writes to the user's real files. Replay only happens in `agent-typewriter:` mirror documents.
- Applying the planner's hunks to a change's before text must reproduce its after text exactly. The fuzz test in `test/` guards this; keep it passing.

## Proposing changes

Small fixes can go straight to a pull request.

Features and changes to specified behavior are written up first as an [OpenSpec](https://github.com/Fission-AI/OpenSpec) change under `openspec/changes/<name>/` (proposal, design, spec deltas, tasks). The current behavior is specified in `openspec/specs/`, and `openspec/changes/archive/` shows how earlier changes were written. If you use Claude Code, the `/opsx:*` commands in `.claude/` walk through propose, apply, and archive. Opening an issue to discuss a larger idea before writing the change is also fine.

## Pull requests

- Branch from `main` and open the PR against `main`.
- Add or update tests for the behavior you change. Integration tests live in `it/`, unit tests in `test/`.
- CI runs typecheck, unit tests, and integration tests on Ubuntu and Windows, then packages the `.vsix`. It must be green before merge.
- If the PR implements an OpenSpec change, archive the change on the branch once its tasks are done, so the updated specs land with the code.
- Add a line to the top section of [CHANGELOG.md](CHANGELOG.md) for user-visible changes.

## Releasing (maintainers)

1. In a PR, set `version` in `package.json` and replace the CHANGELOG's `(unreleased)` heading with that version and the date.
2. After it merges, tag the merge commit `v<version>` and push the tag. CI checks the tag against `package.json`, publishes the tested .vsix to the Marketplace, and creates the GitHub release.

## License

By contributing, you agree that your contributions are licensed under the [MIT License](LICENSE).
