# Tasks

## 1. Marketplace catalog and versioning

- [ ] 1.1 Add `.claude-plugin/marketplace.json` at the repository root: `name` and the plugin entry's `name` both `agent-typewriter`, a `description`, `owner` (name and GitHub URL, no email), and one entry with `"source": "./claude-code"` and no display fields or `version`. Verify `npx -y @anthropic-ai/claude-code@2.1.309 plugin validate . --strict` passes.
- [ ] 1.2 Remove `version` from `claude-code/.claude-plugin/plugin.json`. Verify `plugin validate claude-code --strict` still passes and that `npm run package` builds a `.vsix` whose file list has no `.claude-plugin/` or `claude-code/` entry.

## 2. Checks

- [ ] 2.1 Add `scripts/check-claude-code.mjs`, holding the pinned CLI version once, that runs `plugin validate . --strict`, `plugin validate claude-code --strict`, `plugin test claude-code`, then the install check from design.md (fresh temporary `CLAUDE_CONFIG_DIR`, `plugin marketplace add` of the checkout, `plugin install agent-typewriter@agent-typewriter`, `plugin list --json` shows it), and removes the temporary folder. Point `check:claude-code` at it and rename the CI step. Verify `npm run check:claude-code` passes, and fails when the entry's source is changed to `./missing` and when an unknown field is added to the catalog (then revert both).
- [ ] 2.2 Update `CLAUDE.md` (the `check:claude-code` line and the Architecture entry for the catalog) and the "Claude Code plugin" section of `CONTRIBUTING.md` for what `check:claude-code` now checks. Verify by reading both.

## 3. Install from GitHub

- [ ] 3.1 Push the branch and, in a fresh temporary `CLAUDE_CONFIG_DIR`, run `claude plugin install agent-typewriter --marketplace burnzy1148/agent-typewriter#<this branch>` with the pinned CLI. Verify it adds the `agent-typewriter` marketplace, installs `agent-typewriter@agent-typewriter`, and that `plugin list` shows a commit as its version.
- [ ] 3.2 Push a commit that changes `claude-code/`, then run `plugin marketplace update agent-typewriter` and `plugin update agent-typewriter@agent-typewriter` in the same folder. Verify the plugin updates to the new commit, and note whether a commit outside `claude-code/` also counts as an update (design.md, Risks). Drop the test commit before review.

## 4. Docs

- [ ] 4.1 In `claude-code/README.md`, replace the trying-it section with installing: the one-step command in a session and in a shell, the desktop app's plugin browser once the marketplace is added, `#main` for released versions only, the testers' branch `#claude-code-extension` until it reaches `develop`, updating (`/plugin marketplace update`, auto-update), and switching refs. Keep `--plugin-dir` for working on the plugin. Verify `plugin validate . --strict` no longer prints the missing-install-line advice and every command in the section ran in 3.1 or 3.2.
- [ ] 4.2 In `CONTRIBUTING.md`, document how the marketplace is served (the ref table from design.md), installing a PR's branch to test it, and that a stable release is what releases the plugin to `#main` users. Verify by reading the section against design.md.
- [ ] 4.3 File a bead, `discovered-from:at-o3z.2`, for when `claude-code-extension` merges into `develop`: drop the testers' branch note from `claude-code/README.md` and add a CHANGELOG entry for the plugin. Verify with `bd show`.

## Workflow follow-up

- Open a PR into `claude-code-extension`, turn on Auto-fix, and wait for CI to be green.
- Archive the change on the PR branch once its tasks are done and CI is green, so `openspec/specs/claude-code-distribution/spec.md` lands with the code.
- Do not merge; the maintainer merges.
