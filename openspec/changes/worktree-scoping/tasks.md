# Tasks

## 1. Git access

- [x] 1.1 Add `src/worktrees.ts`: parse `git worktree list --porcelain -z` (and the newline form for git < 2.36) into `{ path, head, branch?, detached }`, `listWorktrees(folder, run)` returning `unavailable` / `not-repo` / `ok`, path normalization (`realpath`, Windows case-folding), and pure helpers for "own checkout of a folder" (longest listed path containing it), "worktrees nested under a root" as `dir/` prefixes, and unique labels (basename, then `parent-name` on collision); verify `test/worktrees.test.ts` covers branch, detached, bare and prunable records, both output forms, a folder that is a subdirectory of its checkout, sibling vs nested worktrees, label collisions, not-a-repo, and git missing

## 2. Checkout scope in the recorder

- [x] 2.1 Introduce a per-folder `CheckoutScope` (`root`, `own`, `label`, `nested`) and route `relPathOf`, `displayPathOf`, `passes`, ignore snapshots, git baselines, and `readBlob` through `rootOf(uri)` instead of `getWorkspaceFolder` / `asRelativePath`; with no git the scope is the folder itself; verify `npm run typecheck`, `npm test`, and the existing `npm run it` sections pass unchanged
- [x] 2.2 On `start()` and `refreshFilter()`, list worktrees per folder, fill `nested`, add nested prefixes to `passes` and to the `findFiles` exclude glob, and log "Skipping N other worktrees" once per start; add "other worktrees skipped" to `describeFilter()` when any are; verify with an integration section that a write inside a nested worktree is not recorded, a write in the main checkout is, and a submodule-like nested repository that is not a worktree is still recorded
- [x] 2.3 Detect worktree add/remove: in `schedule`, a `.git` file event below the root provisionally adds its directory to `nested` and schedules a debounced `refreshWorktrees()` that re-lists, rebuilds `nested`, drops baselines under new prefixes, and baselines newly un-excluded files; `flush` re-checks `passes`; verify with an integration section that `git worktree add .worktrees/late` while recording, followed by writes there, records nothing

## 3. Recording a chosen checkout

- [x] 3.1 Add `recorder.setCheckout(folder, path | undefined)`: resolves the path against the worktree list (keeping the folder's subpath within the checkout), bumps `baselineGen`, drains held changes, replaces that folder's watcher, clears its baselines and ignore snapshot, and recaptures; for a non-own root use a `RelativePattern(Uri.file(root), '**/*')` watcher and a pruned `workspace.fs.readDirectory` walk for baseline candidates; verify `npm run typecheck` and existing sections pass
- [x] 3.2 Prefix display paths with the scope `label` when `own` is false, so mirror URIs, the timeline view, and saved sessions are distinct per checkout; verify a unit test of the display-path helper and that `planHunks`/fuzz tests are unaffected (`npm test`)
- [x] 3.3 Fall back to the folder's own checkout when the chosen root is deleted or missing from a refreshed worktree list, with one output-channel line; verify with the integration section in 5.1

## 4. Command, status, and persistence

- [x] 4.1 Add `agentTypewriter.chooseCheckout` (contributed in `package.json`, with a palette title "Agent Typewriter: Choose Checkout"): multi-root folder pick among folders in a repository, then a quick pick of own checkout first and other worktrees by branch or short sha with path as detail; accept an optional `(folderUri, worktreePath)` argument for tests; store the choice in `checkouts.json` in workspace storage (see design: Persisting the choice); outside a repository show "no other checkouts"; verify the integration sections run the command with arguments and `npm test` covers the choice file
- [x] 4.2 Apply the stored choice in `start()` and call `recorder.setCheckout` when the choice changes while recording; verify by reloading the integration window in `it/restore.ts` and checking the chosen worktree is still recorded
- [ ] 4.3 Add a `$(git-branch) <label>` status bar item that runs the command, shown when the folder's repository has more than one worktree, and add the label to the main status tooltip and the timeline view description when a non-own checkout is recorded; verify manually in the Extension Development Host with this repository's `.claude/worktrees/`
- [x] 4.4 Document worktrees in the README (default exclusion, Choose Checkout, labels in paths, fallback, no-git behavior) and add a CHANGELOG entry noting the behavior change; verify the README section matches the command title and status bar text

## 5. Integration checks

- [ ] 5.1 In `it/runTest.ts` create a nested worktree (`.worktrees/nested`) and a sibling worktree next to the workspace; add a section that chooses the sibling, writes `src/a.ts` there and in the main checkout, expects only the sibling's change as `<label>/src/a.ts` replayed into its own mirror, switches back with a change still queued and expects it to play, then removes the sibling worktree and expects the fallback; verify `npm run it` passes locally and on CI (Ubuntu and Windows)

## Workflow follow-up

- Archive on the PR branch once tasks are done and CI is green, then merge.
