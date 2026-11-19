## 1. Shared history reader

- [ ] 1.1 Create `src/gitHistory.ts` with the `HistoryReader` interface and move into it, from `src/gitReplay.ts`, `resolveRange`, `parseCommits`, `parseDiffTree`, the rename filter and rename-side fallbacks, LFS pointer detection, the equal-text rule, skip counting, the default-base rules over the reader, and `buildHistory(reader, revs, { maxBytes, isCancelled })` returning commits, folder-relative changes (path, `fromPath`, kind, before, after, eol, commit) and skips. No `vscode` or Node imports.
- [ ] 1.2 Make `src/gitReplay.ts` the Node adapter: a `HistoryReader` over `runReplayGit` (BOM decoding, the shallow file, `cat-file -s`), filters and mirror paths applied around `buildHistory`, and every existing export kept with its signature.
- [ ] 1.3 Run `test/gitReplay.test.ts` unmodified, plus `npm test` and `npm run it`; add unit tests for `buildHistory` over a fake reader (renames with a skipped side, LFS, shallow set, equal text, cancel).
- [ ] 1.4 Add `gitHistory` exports to `CORE_ENTRY` in `scripts/build-claude-code.mjs`, update the bundle header's file list, and run `npm run build:claude-code`; commit `core.mjs` and `core.d.mts`.

## 2. The plugin's git reader

- [ ] 2.1 Create `claude-code/hooks/git.ts`: a `HistoryReader` over `$.process.run(['git', ...], { cwd, env, timeoutMs })` with `GIT_NO_LAZY_FETCH=1`, `GIT_LFS_SKIP_SMUDGE=1`, `GIT_OPTIONAL_LOCKS=0`, `GIT_TERMINAL_PROMPT=0`; non-zero exits become `gitReason(stderr)`; a rejected run (timeout, cannot start) becomes a clear error.
- [ ] 2.2 Sizes through one `cat-file --batch-check` per replay on stdin; contents through `cat-file blob`, at most 8 at a time; binary detected on decoded text with `isBinaryText`.
- [ ] 2.3 Shallow boundary: `rev-parse --is-shallow-repository`, then parentless commits of the range (`rev-list --parents`).
- [ ] 2.4 Repository check (`rev-parse --is-inside-work-tree`) and the default base, with the "no default branch" answer.
- [ ] 2.5 Pull requests: argument check (digits, `#digits`, `https://…/pull/<digits>`, nothing starting `-`), `gh pr view <arg> --json number,url,headRefOid,commits`, `cat-file -e` on the head with the `git fetch origin pull/<n>/head` answer, the 250-commit answer, parents of the listed commits to form `head ^B…`, and gh-missing / gh-failure answers.
- [ ] 2.6 Tests with a fake `$.process.run`: argv and env of every call (nothing but reads), each answer above, timeouts, truncated stdout treated as unreadable.

## 3. Replayed changes in the deck

- [ ] 3.1 `Change` and `SavedChange`: `kind` adds `delete` and `rename`, `fromPath?`, `commit?`; ids `git:<sha>:<path>`; caption from the subject through `normalizeCaption`.
- [ ] 3.2 Building a replay into the deck in one step: cut to the newest changes that fit the limits on their own, drop the earlier replay lane and its changes, define the lane (`git-replay:<label>`, `recording: false`, `kind: 'git'`, color from `colorSlot`), push, follow, seek to its first change, unpause; return loaded and total counts.
- [ ] 3.3 Playback of deletes and renames (rename typed from the old text under the new path; pure rename finishes at once), and the equal-text exception for renames.
- [ ] 3.4 `savedOf` / `savedFrom` with the new tag after at-o3z.15's, reading every older tag; `SavedLane.kind`.
- [ ] 3.5 Tests: numbering goes on, limits cut and drop rule, replacing a replay, reload mid-replay, old tags load.

## 4. List and pane

- [ ] 4.1 `chaptersOf`: commit chapters keyed `commit:<sha>` with title (7-character hash), subject as prompt, count and `Play commit`; replayed changes never in `Outside a turn`.
- [ ] 4.2 `rowLabel` / `listingOf`: `Add`, `Modify`, `Delete`, `Rename` in the tool column; a rename named by its new path; new listing tag.
- [ ] 4.3 register.tsx: no Show in conversation button and no ↗ for a change without a call; Play commit keyed `play-commit:<sha>` through `move()`; header `(git)` for the replay lane's kind.
- [ ] 4.4 Tests in `claude-code/tests/` for chapters, rows, the header and the missing buttons.

## 5. Commands

- [ ] 5.1 Register `/typewriter` with the new description and `argumentHint: '[replay [range] | pr <number>]'`.
- [ ] 5.2 `command.run`: terminal-only answer first; split `args`; empty opens the pane as today; `replay` and `pr` replay; anything else answers usage without opening the pane.
- [ ] 5.3 `live.replaying`: refuse a second replay while one is read; on success open the pane as `/typewriter` does, answer with the range or pull request, changes and commits, loaded of total, skips by reason, and the no-surface pointer when no surface is attached.
- [ ] 5.4 Tests: each answer in the delta's scenarios, including terminal session, not a repository, invalid and empty range, two replays at once, unknown subcommand, replay while paused.

## 6. Docs and checks

- [ ] 6.1 `claude-code/README.md`: `/typewriter replay` and `/typewriter pr`, read-only, needs gh for pull requests, nothing fetched.
- [ ] 6.2 `npm test`, `npm run it`, `npm run check:claude-code`, `npm run typecheck:claude-code`.
- [ ] 6.3 Try it in a desktop session on this repository: `/typewriter replay`, a typed range, `/typewriter pr` for a merged pull request with a local head; confirm `git status` and the refs are unchanged after.

## 7. Before archiving

- [ ] 7.1 After at-o3z.15 archives, rebase the delta onto the living spec and add MODIFIED blocks for *A lane per loop* and *Running and finished lanes* naming the replay's lane.
- [ ] 7.2 Check at-o3z.20's saved replays carry `kind`, `fromPath` and `commit`, and at-o3z.19's scrubber gaps between commits; adjust this delta if either archived first.
- [ ] 7.3 `openspec validate claude-code-git-replay --strict`.
