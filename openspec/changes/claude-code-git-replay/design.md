# Design

## Context

See proposal.md for why. What the change builds on:

- **The extension's git replay** (`src/gitReplay.ts`, spec `git-replay`) already turns a range into timeline events: `resolveRange` (input to rev-list arguments, refusing `-`), `listCommits` (`rev-list --reverse --topo-order --no-merges`), `commitChanges` (`diff-tree -r -z --raw -M --root --relative`), `parseDiffTree`, rename-side fallbacks, skip counting (`ReplaySkips`), LFS pointer detection, `defaultBase`, `gitReason`, and `replayLane(range)`. It imports `node:fs`, `node:path` and `gitBaseline`'s Node runner, so it cannot join the neutral `core.mjs` bundle as it is.
- **`$.process.run(argv, { cwd, env, stdin, timeoutMs })`** runs a command by argument vector, no shell, and resolves `{ exitCode, stdout, stderr }` as text, each stream cut at 4 MiB (`isStdoutTruncated`). Timeout 30 s by default, ten minutes at most. Git runs with repo hooks off. It is a CLI-host API, which the desktop app's and VS Code's local sessions are.
- **`command.run`** hands the hook `args`, everything after the name as typed. `$.command.register` takes `argumentHint`.
- **Lanes** come from at-o3z.15 (`claude-code-subagent-lanes`, not yet implemented): a lane per `agentId`, Main `''`, defined at its first change with `timeline.defineLane`, `recording` meaning running, `giveWay` for a finished lane that played out, auto-follow from `src/lanes.ts`, chips, header and row tags, `saved-5`.
- **The plugin's `Change`** has `kind: 'create' | 'modify'`, `tool?`, `caption?` and call links. Its chapters (at-o3z.13) are per main turn, with `Outside a turn` and `Earlier turn`; file groups (at-o3z.27) key on the path.

## Goals / Non-Goals

**Goals:**
- One reading of history for both frontends: the same commits, the same per-file changes, the same skips, from one pure module.
- Never change the repository, and never fetch: the plugin's whole contract is that it reads.
- Fit the replay into the pane's existing model (a lane, chapters, rows, captions) rather than add a mode.

**Non-Goals:**
- Pickers. The extension's quick picks (folder, This branch, A branch, Last commit, typed range) have no counterpart in a slash command; `/typewriter replay` with no range is "This branch", and anything else is typed.
- Path filters. The plugin keeps none (at-o3z's later path-pattern option may apply to replays when it lands).
- Fetching for a pull request.

## Decisions

### A pure history reader shared through the bundle

Move the logic of `buildReplay` into `src/gitHistory.ts`, which imports only `planner` (for `countChanges`, `detectEol`, `normalizeEol`) and takes a reader:

```ts
interface HistoryReader {
  revList(args: string[]): Promise<string>;      // rev-list output, git's reason on failure
  diffTree(sha: string): Promise<string>;         // diff-tree -r -z --raw -M --root --relative
  blobSize(sha: string): Promise<number | undefined>;
  blobText(path: string, sha: string): Promise<string | 'binary' | 'unreadable'>; // decoded
  shallow(): Promise<Set<string>>;                // boundary commits
}
```

It exports `resolveRange`, `parseCommits`, `parseDiffTree`, `buildHistory(reader, revs, { maxBytes, isCancelled })` and the skip counters; LFS detection, the equal-text rule and rename fallbacks stay inside it. `src/gitReplay.ts` keeps its exports (the extension and its tests import them) and becomes the Node adapter: `GitRunner` with `GIT_NO_LAZY_FETCH`/`GIT_LFS_SKIP_SMUDGE`, Buffer blobs decoded by BOM, the shallow file read from disk, filters and mirror paths. Its tests must pass unchanged; that is the guard that the extension's behavior did not move. `gitHistory.ts` joins `CORE_ENTRY`.

`buildHistory` returns folder-relative paths and kinds, not timeline events, so each frontend makes its own events (the extension's `uri`/`relPath` mirror naming; the plugin's absolute `path` under the session's cwd).

*Alternative:* re-implement the reader in `claude-code/hooks/git.ts`. Less churn now, but two copies of rename and skip rules that the specs say behave the same, and at-dqb.4 would make three.

### The plugin's reader over `$.process.run`

`claude-code/hooks/git.ts` implements `HistoryReader` with `$.process.run(['git', ...], { cwd, env })`, `env` = `GIT_NO_LAZY_FETCH=1`, `GIT_LFS_SKIP_SMUDGE=1`, `GIT_OPTIONAL_LOCKS=0`, `GIT_TERMINAL_PROMPT=0`. Every command is a plumbing read (`rev-parse`, `symbolic-ref -q`, `rev-list`, `diff-tree`, `cat-file`); none takes a lock or writes a ref. A non-zero exit becomes `gitReason(stderr)`.

- **Sizes before contents.** One `git cat-file --batch-check` with the replay's blob ids on stdin answers every size at once, so a blob over `MAX_REPLAY_BYTES` (1,000,000) is never read. Contents come one `cat-file blob <sha>` per blob, at most 8 at a time. `--batch` would be one process, but its byte-counted framing cannot be parsed from decoded text.
- **Text, not bytes.** `stdout` arrives decoded as UTF-8, so binary is detected on the text (`isBinaryText`: a NUL, or a high share of replacement characters). A UTF-16 file therefore counts as binary in the plugin, where the extension decodes it by BOM; this is the one place the two may differ, and it errs toward skipping.
- **Shallow boundary without reading `.git/shallow`.** The plugin reads no file but the ones its calls touched. In a repository that `rev-parse --is-shallow-repository` says is shallow, the reader lists the range's commits with `--parents`, and a commit with no parents counts as at the boundary. A shallow clone that holds its true root commit would skip that commit too, which replays nothing a person would miss.
- **Timeouts.** `rev-list` and `diff-tree` get 60 s; blobs the 30 s default. A timeout ends the replay with the answer "git did not answer in time", changing nothing.
- **Default base** is `defaultBase` from the extension's rules (`symbolic-ref refs/remotes/origin/HEAD`, then the four fallbacks, each checked with `rev-parse --verify -q <ref>^{commit}`), moved into `gitHistory.ts` over the reader so both share it.

### Pull requests: the commits GitHub lists, only when they are local

`gh pr view <arg> --json number,url,headRefOid,commits` in the session's cwd. The argument is checked first: digits, `#` and digits, or an `https://` URL whose path ends `/pull/<digits>`; anything else, and anything starting with `-`, is refused before gh runs. Then:

1. `git cat-file -e <headRefOid>^{commit}`. Missing: answer that the pull request's commits are not here and name `git fetch origin pull/<n>/head` (GitHub's ref for any pull request, fork or not). The plugin does not run it.
2. The commit set S is the `oid`s gh lists. Their order comes from git, not GitHub: `git rev-list --no-walk --parents S` gives each commit's parents, the parents outside S are the base boundary B, and the replay's revisions are `headRefOid ^B…`, so `buildHistory` lists exactly S (merges dropped) in topological order, like a typed range.
3. GitHub lists at most 250 commits for a pull request. When gh lists 250, the answer says the pull request may have more and that `/typewriter replay <base>..<head>` replays all of them; the 250 are not replayed, since a cut list can make B wrong.

gh missing (`ENOENT` from `$.process.run`) answers that replaying a pull request needs the GitHub CLI, signed in; gh's own failure (not signed in, no such pull request, not a GitHub repository) answers with its stderr's first line.

*Why the commit list rather than `baseRefOid..headRefOid`:* `baseRefOid` is the base branch's tip on GitHub now, often newer than the local repository's, so the range would be unresolvable even though every commit of the pull request is here. The head commit's ancestry is local whenever the head is.

*at-dqb.4 consistency:* the extension's pull request replay is still `needs-spec`. This design takes "only what is already local, never fetch" and "the commits GitHub lists"; a note on at-dqb.4 proposes the same so the two frontends agree. Nothing in this change touches the extension's commands.

### The replay is one lane, labeled by what was asked

The lane id is `git-replay:<label>`, the extension's `replayLane` id scheme, which cannot collide with an `agentId`. Its label is the range as typed (trimmed, whitespace runs as single spaces), the replayed default (`origin/develop..HEAD`), or `PR #123`. It is defined with `recording: false`, so `giveWay` hands over once it plays out, and with the color `colorSlot` gives any new lane. `LaneInfo` gains `kind: 'git'`, which the header draws as `(git)` where a subagent's lane draws its type.

Building the replay is asynchronous and the deck is not touched until the history is read. Then, in one synchronous step: drop the earlier replay lane's changes and the lane (one replay lane at a time keeps a long session from stacking histories in the shared limits; a second replay is what someone does to look at something else), push the new changes in their lane, `follow` it, `seek` to its first change, unpause, and treat it as `move()` (the list keeps up again, a pinned tab from at-o3z.16 is cleared). Then `$.ui.open` as `/typewriter` does, and answer.

*Alternative:* the extension's behavior, replacing the whole buffer and stopping recording. Rejected: the pane's job in Claude Code is the session, and the bead asks for the replay "in its own lane". The session keeps recording into its lanes, and auto-follow brings them back once the replay plays out and the 3 s quiet passes.

*Alternative:* keep every replay as its own lane. More chips and a buffer that fills with histories; a person who wants an earlier replay back runs it again.

### Limits

`buildHistory` returns every change; the plugin keeps the newest suffix that fits `MAX_WAITING` changes and `MAX_WAITING_CHARS` characters on its own, before pushing, and says "loaded N of M". Pushing then lets the timeline's existing drop rule make room, played changes first, oldest first. A replay can therefore drop the session's played changes; it never drops a queued one, because the timeline never does.

### What a replayed change is

`Change` gains:
- `kind: 'create' | 'modify' | 'delete' | 'rename'`, and `fromPath?` (absolute) for a rename;
- `commit?: { sha: string; subject: string }`, present exactly on replayed changes; no `tool`, no call links;
- `caption` = the commit's subject, through `normalizeCaption`, so the caption band and hover card need no new code.

Ids are `git:<sha>:<path>`, which no `tool_use_id` matches, so the text family, `changeById` and the conversation chip (which looks up by call id) work without a branch. `scrollTargets` returns nothing for a change without a call; register draws no Show in conversation and no ↗ when it is empty.

A delete plays as removing the file's whole text, which the long-deletion rule shows in one step, and its row reads `Delete`. A rename types from the old path's text in a change named by the new path; at-o3z.16's tabs replace the old path's tab with the new one, and a delete closes its tab. A pure rename has nothing to type and finishes at once, still listed. Too-large changes are skipped rather than listed as Too large: their size is known before reading, and listing history the pane will not type adds rows without content.

### Chapters and rows

`chaptersOf` puts a change with `commit` in a chapter keyed `commit:<sha>`, with header label `{ title: sha.slice(0,7), prompt: subject, count, play: 'Play commit' }` through the same `headerLabel` cutting as a turn. Chapter ordering is unchanged (earliest kept change), so a replay's commits follow the session's earlier turns. `rowLabel` takes `kind` in the tool column when there is no tool: `Add`, `Modify`, `Delete`, `Rename`. By-file grouping needs nothing new: a replayed change's absolute path is `cwd` joined with the repo-relative-to-cwd path, the same key a session `Edit` of that file has.

### Commands

`$.command.register({ name: 'typewriter', description: 'Open the Agent Typewriter pane, or replay git history', argumentHint: '[replay [range] | pr <number>]' })`. `command.run` splits `args` on the first whitespace: empty opens the pane (today's behavior), `replay` and `pr` replay, anything else answers usage. A terminal-only session answers `TERMINAL_POINTER` before parsing. `live.replaying` refuses a second replay while one is read; it is module memory, so a reload drops an in-flight read, whose results never reach the deck.

### State shapes

- `SavedChange` gains `fromPath?`, `commit?` and the wider `kind`. `Saved` takes the tag after at-o3z.15's `saved-5` (expected `saved-6`); `savedFrom` reads every older tag, where no change has a commit. `SavedLane` gains `kind?: 'git'`.
- `Listing`'s `Row` gains `kind` and `commit?: { sha, subject }` (new tag); `View` gains nothing, since the header's lane fields come from at-o3z.15 and `(git)` rides on its `kind`.
- Replayed changes' texts go in the `text` family like any change, so they survive a reload and count toward the same budget.

### Order with the in-flight changes

Implementation comes after at-o3z.15 (lanes are required), and in the plugin queue after .16, .6, .17, .18 and .20. Effects:
- **.15:** its *A lane per loop* says every kept change belongs to "the lane of the loop that made it", and *Running and finished lanes* names only Main and subagents. This delta's *A replay has its own lane* adds the replay's lane; once .15 archives, task 7.1 adds MODIFIED blocks so those two requirements name it.
- **.16:** delete closes a tab, rename moves it; Play commit and starting a replay go through `move()`.
- **.20 (saved replays):** its saved shape must carry `kind`, `fromPath` and `commit` so a saved git replay loads with its chapters. Its design is in flight; task 7.2 checks it.
- **.19 (scrubber):** a gap between commits plays the part of a gap between turns.
- No MODIFIED block here touches a requirement any in-flight delta modifies (checked against .15, .16, .6, .17 and .18; .19 and .20 had no delta pushed when this was written).

## Risks / Trade-offs

- [Large ranges are slow: one process per blob] → sizes in one call, 8 blobs at a time, the newest-that-fit cut applied to commits before reading their blobs where the count alone already exceeds the limit; the command shows the answer only when done.
- [A replay drops the session's played changes to make room] → the answer says how many were loaded, the list's dropped line says how many went, and queued changes are never dropped.
- [UTF-16 files count as binary in the plugin] → counted and named in the answer; rare in source trees.
- [gh output format drift] → only `--json` fields are read, by name.
- [A pull request with more than 250 commits cannot be replayed by number] → the answer points to a range, which has no cap.
- [Moving extension code into a shared module could change its behavior] → its existing tests stay unmodified and must pass; the fuzz and integration suites run too.

## Migration Plan

Within a session, a reload into this version reads the previous `saved` tag; no change has a commit or a new kind, so nothing else moves. A downgrade reads the new tag as unknown and starts fresh, the existing rule for shape changes. Nothing outlives a session.

## Open Questions

None blocking. The owner may prefer the extension's "replace the buffer" model or keeping several replay lanes; both are local to the replay's lane step.
