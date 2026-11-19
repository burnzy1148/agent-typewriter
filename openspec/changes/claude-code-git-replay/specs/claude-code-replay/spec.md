## ADDED Requirements

### Requirement: Replay a commit range
`/typewriter replay` followed by a range in git's revision syntax SHALL replay the range's non-merge commits, oldest first, from the git repository holding the session's working directory, with one replayed change per changed file per commit. A replayed change's before text SHALL be the file in the commit's parent and its after text the file in the commit, both read from git. One commit named on its own SHALL replay that commit.

#### Scenario: Replay a branch
- **WHEN** branch `feature` has two commits on top of `main`, the first changing `src/a.ts` and adding `src/b.ts`, the second changing `src/a.ts` again, and the user runs `/typewriter replay main..feature`
- **THEN** the replay holds a modify of `src/a.ts`, an add of `src/b.ts`, and a modify of `src/a.ts`, in that order
- **AND** the second `src/a.ts` change starts from the text the first one ended with

#### Scenario: Working tree differs from history
- **WHEN** `src/a.ts` has uncommitted edits on disk and the user replays a range that changes it
- **THEN** each change's before and after text is the committed text, not the text on disk

#### Scenario: Single commit
- **WHEN** the user runs `/typewriter replay abc1234`
- **THEN** only that commit's changes are replayed

### Requirement: Option-like input is refused
A range or pull request argument starting with `-` SHALL be refused, and neither git nor the GitHub CLI SHALL run.

#### Scenario: Option-like input
- **WHEN** the user runs `/typewriter replay --all`
- **THEN** the answer says `--all` is not a revision, and git is not run

### Requirement: The default range
`/typewriter replay` with no range SHALL replay the commits of `HEAD` that are not on the default branch. The default branch SHALL be the remote's default branch when git knows it, else the first of `origin/main`, `origin/master`, `main`, `master` that exists. When none exists, the answer SHALL say so and ask for a range.

#### Scenario: Remote default branch
- **WHEN** `origin/HEAD` points at `origin/develop` and the user runs `/typewriter replay`
- **THEN** the commits of `origin/develop..HEAD` are replayed

#### Scenario: No default branch
- **WHEN** the repository has none of the default branch candidates and the user runs `/typewriter replay`
- **THEN** the answer says no default branch was found and asks for a range, and nothing is replayed

### Requirement: Replay a pull request
`/typewriter pr` followed by a pull request's number, `#` and its number, or its URL SHALL ask the GitHub CLI, run in the session's working directory, for the pull request's head commit and commits, and SHALL replay those commits, oldest first, merge commits skipped. Any other argument SHALL be refused without running the GitHub CLI.

#### Scenario: Pull request whose head is local
- **WHEN** pull request 123 has three commits, its head commit is in the local repository, and the user runs `/typewriter pr 123`
- **THEN** the changes of those three commits are replayed, oldest first

#### Scenario: Pull request by URL
- **WHEN** the user runs `/typewriter pr https://github.com/acme/app/pull/123`
- **THEN** pull request 123 of `acme/app` is replayed as with `/typewriter pr 123`

#### Scenario: Merge from the base branch
- **WHEN** a pull request merged its base branch into itself and the user replays it
- **THEN** the merge commit adds no changes, and the pull request's own commits are replayed

### Requirement: A pull request is replayed only when it is local
When a pull request's head commit is not in the local repository, nothing SHALL be replayed or fetched, and the answer SHALL say so and name a `git fetch` command that would bring it. When the GitHub CLI is missing, not signed in, or cannot find the pull request, the answer SHALL give its reason.

#### Scenario: Head not fetched
- **WHEN** pull request 123's head commit is not in the local repository and the user runs `/typewriter pr 123`
- **THEN** nothing is replayed, nothing is fetched, and the answer says the pull request's commits are not here and names `git fetch origin pull/123/head`

#### Scenario: GitHub CLI missing
- **WHEN** the GitHub CLI is not installed and the user runs `/typewriter pr 123`
- **THEN** the answer says replaying a pull request needs the GitHub CLI, and nothing is replayed

### Requirement: A replay's answer
A replay SHALL answer with what it replayed: the range or pull request, how many changes from how many commits, and how many changes and commits it skipped and why. When the session's working directory is not in a git repository, git cannot resolve the range, or the range holds no commits with replayable changes, the answer SHALL say so, and the kept changes, lanes and playback SHALL be unchanged.

#### Scenario: Replayed with skips
- **WHEN** the user replays a range of 5 commits whose changes include 12 text files, a PNG and a merge commit
- **THEN** the answer says 12 changes from the range's commits were replayed, and that 1 binary change and 1 merge commit were skipped

#### Scenario: Not a repository
- **WHEN** the session's working directory is not in a git repository and the user runs `/typewriter replay`
- **THEN** the answer says so, and the pane, its lanes and playback are unchanged

#### Scenario: Invalid range
- **WHEN** the user replays a range git cannot resolve
- **THEN** the answer gives git's reason, and nothing changes

#### Scenario: Empty range
- **WHEN** the range holds no commits with replayable changes
- **THEN** the answer says there is nothing to replay, and nothing changes

### Requirement: One replay at a time
While a replay is being read, another `/typewriter replay` or `/typewriter pr` SHALL be refused, and the first SHALL go on.

#### Scenario: Two replays at once
- **WHEN** a replay of a long range is still being read and the user runs `/typewriter pr 123`
- **THEN** the answer says a replay is already being read, and the first replay goes on

### Requirement: What a replay keeps
Only regular files inside the session's working directory SHALL be replayed, each named as the pane names a file there. A file a commit added SHALL replay as an add, a removed file as a delete, a file git detects at its default similarity as renamed as a rename, and any other changed file as a modify. When one side of a rename is skipped or lies outside the working directory, the other side SHALL replay as a delete of the old path or an add of the new one.

#### Scenario: Working directory below the repository top
- **WHEN** the session runs in `repo/pkg` and a replayed commit changes `repo/pkg/src/a.ts` and `repo/README.md`
- **THEN** one change is replayed, to `src/a.ts`

#### Scenario: Renamed file
- **WHEN** a replayed commit runs `git mv src/a.ts src/b.ts` and edits one line of it
- **THEN** one rename from `src/a.ts` to `src/b.ts` is replayed, typed from the text of `src/a.ts`

#### Scenario: Pure rename
- **WHEN** a replayed commit renames `src/a.ts` to `src/b.ts` without changing it
- **THEN** the rename is still replayed and listed

### Requirement: What a replay skips
Merge commits, symbolic links, submodules, binary files, files larger than 1,000,000 bytes on either side of a change, Git LFS pointers, and contents git cannot read SHALL be skipped, as SHALL a change whose before and after text are equal, unless it is a rename. In a shallow clone, the commits at the clone's boundary SHALL be skipped.

#### Scenario: Large file
- **WHEN** a replayed commit adds a 2 MB generated file
- **THEN** that change is skipped and counted as too large, and its contents are not read

#### Scenario: Shallow clone
- **WHEN** the repository is a shallow clone and the range reaches its oldest commit
- **THEN** that commit is skipped instead of replaying every file as added

### Requirement: Replaying only reads the repository
Replaying SHALL NOT change the repository or the user's files: no checkout, fetch, commit or ref update, and no change to HEAD, the index or the working tree. A partial clone's missing contents SHALL NOT be fetched, and Git LFS content SHALL NOT be downloaded. Replayed changes SHALL be typed only into the pane.

#### Scenario: Repository untouched
- **WHEN** the user replays a range and playback types every change
- **THEN** HEAD, the branches, the index and every file in the working tree are as they were before the replay

#### Scenario: Partial clone
- **WHEN** the repository is a partial clone that lacks some old file contents and the user replays a range that needs them
- **THEN** nothing is fetched (with git 2.44 or later), and the changes whose contents are missing are skipped and counted as unreadable

### Requirement: A replay has its own lane
A replay's changes SHALL belong to one lane of their own, labeled with the range as typed, the default range as replayed when none was typed, or `PR #` and the pull request's number. The lane SHALL take a color as any new lane does, and SHALL count as finished. The session's own lanes SHALL keep recording during and after a replay.

#### Scenario: Replay beside the session's changes
- **WHEN** Claude has made three changes in the main conversation and the user runs `/typewriter replay main..feature`
- **THEN** the three changes stay in Main's lane, and the replay's changes are in a lane labeled `main..feature`

#### Scenario: Claude edits during a replay
- **WHEN** the replay's lane is followed and typing, and Claude edits `src/app.ts` in the main conversation
- **THEN** the change is recorded in Main's lane and waits there, and the replay goes on typing

#### Scenario: The replay plays out
- **WHEN** the replay's lane has played its last change and Main has two changes queued
- **THEN** Main is followed and its two changes are typed

### Requirement: The pane names a replay's lane
While more than one lane holds a kept change and the replay's lane is followed, the pane's header SHALL begin with that lane's color, its label and `(git)`.

#### Scenario: Header of a followed replay
- **WHEN** Main holds changes and the `main..feature` replay's lane is followed
- **THEN** the header begins with that lane's color and `main..feature (git)`

### Requirement: A new replay replaces the last
A new replay SHALL replace the earlier replay's lane and its changes, and SHALL leave the session's own lanes and any loaded replay's lane as they are.

#### Scenario: Replay again
- **WHEN** a replay of `main..feature` is kept and the user runs `/typewriter pr 123`
- **THEN** the `main..feature` lane and its changes are gone, and a lane labeled `PR #123` holds the pull request's changes

### Requirement: A replay starts playing
When a replay is built, the pane SHALL open as bare `/typewriter` opens it, the replay's lane SHALL be followed, and its first change SHALL start typing, even if playback was paused. A change being typed in another lane SHALL stay queued there. Starting a replay SHALL count as moving playback, as pressing a change in the list does.

#### Scenario: Replay while Main types
- **WHEN** Main is typing change #4 and the user replays a range
- **THEN** the replay's lane is followed and its first change is typed, and Main's change #4 waits in Main

#### Scenario: Replay while paused
- **WHEN** playback is paused on a change of Main and the user replays a range
- **THEN** playback resumes with the replay's first change, and Main's queued changes wait in its lane

#### Scenario: Pane closed
- **WHEN** the pane is closed and the user runs `/typewriter pr 123` in the desktop app
- **THEN** the pane opens and types the pull request's first change

### Requirement: Replays wait for a surface other than the terminal
In a session that draws only on the terminal surface, `/typewriter replay` and `/typewriter pr` SHALL NOT run git or the GitHub CLI and SHALL answer as `/typewriter` does there. When no surface is attached to the session, the replay SHALL still be built, and its answer SHALL add that the pane can't be shown in this session and where it can.

#### Scenario: Terminal session
- **WHEN** the user runs `/typewriter replay main..feature` in a session that draws only in a terminal
- **THEN** git is not run, nothing is replayed, and the answer points to the Agent Typewriter extension for VS Code

### Requirement: Replayed commits are chapters
While By turn is chosen, each replayed commit with a kept change SHALL be a chapter of its own, holding that commit's kept changes in their order. Its header SHALL show the commit's hash cut to 7 characters, its subject on one line, cut as a turn's prompt is, how many of its changes the pane keeps, and a Play commit button that acts as Play turn does. Commit chapters SHALL be ordered among the turns' chapters by their earliest kept change, as chapters are.

#### Scenario: Two commits
- **WHEN** a replay holds two changes from commit `1a2b3c4d` "Add the limiter" and one from `5e6f7a8b` "Guard signup"
- **THEN** the list shows a chapter headed `1a2b3c4`, "Add the limiter", `2 changes` and Play commit, then one headed `5e6f7a8`, "Guard signup", `1 change` and Play commit

#### Scenario: Play commit
- **WHEN** every change has played and the user presses Play commit on the second commit's chapter
- **THEN** that commit's first change is typed from its before text, followed by the later changes of the replay's lane

### Requirement: A replayed change's row and caption
A replayed change's row SHALL show its kind, `Add`, `Modify`, `Delete` or `Rename`, where a recorded change's row shows its tool, and a rename's row SHALL name its new path. A replayed change's caption SHALL be its commit's subject, shown and cut as any caption. A replayed change has no call in the conversation.

#### Scenario: Rows of a replay
- **WHEN** a replayed commit adds `src/b.ts` and deletes `src/old.ts`
- **THEN** their rows read `Add` with `src/b.ts` and `Delete` with `src/old.ts`

#### Scenario: Caption while typing
- **WHEN** the pane types a change of the commit "Guard the login route"
- **THEN** “Guard the login route” shows between the header and the code

### Requirement: Replays share the limits
Replayed changes SHALL count toward the limits on kept changes with every other change, and SHALL be numbered on from the session's kept changes. When a replay holds more changes, or more before and after text, than the limits allow on their own, only its newest changes that fit SHALL be kept, and its answer SHALL say how many of the range's changes were loaded. Older kept changes SHALL then be dropped as the limits already say, played ones first.

#### Scenario: Range larger than the limits
- **WHEN** a range holds 350 replayable changes
- **THEN** its newest 200 changes are kept, and the answer says 200 of its 350 changes were loaded

#### Scenario: Numbers go on
- **WHEN** the session has recorded 9 changes and a replay adds 4
- **THEN** the replayed changes are numbered 10 to 13

### Requirement: Replays survive a reload
Replayed changes, with their texts, kinds, paths, commits and played state, and the replay's lane, SHALL survive a reload of the plugin within the session, as recorded changes do. A replay being read when the plugin reloads SHALL be dropped, and SHALL change nothing.

#### Scenario: Reload during a replay
- **WHEN** a replay's lane has played two of its five changes and the plugin reloads
- **THEN** the lane keeps its label and color, the two changes stay played, and the third starts over

## MODIFIED Requirements

### Requirement: The plugin never writes files
The plugin SHALL NOT create, modify, or delete any file. It SHALL only read the files that recorded tool calls touched, and the repository's history through git and the GitHub CLI when the user replays a range or a pull request.

#### Scenario: Playback finishes
- **WHEN** a change to `a.ts` finishes playing
- **THEN** `a.ts` on disk is exactly as the tool left it

#### Scenario: A replay finishes
- **WHEN** a replayed change to `a.ts` finishes playing
- **THEN** `a.ts` on disk is as it was before the replay

### Requirement: Pane lists the session's changes
Below the code and the playback controls, the pane SHALL list every change the plugin keeps, grouped by turn or by file, as the person chose. Each row SHALL show whether its change has played, is being typed, or waits; its number, counting the session's kept changes from 1 in the order they were recorded or replayed; the tool that made it, `Edit` or `Write`, or for a replayed change its kind; its path, named as the pane names a file; and the lines it adds and removes. A row's number SHALL NOT change for the rest of the session.

#### Scenario: Played, playing and queued
- **WHEN** Claude has made five changes, two have played, the third is being typed and two wait
- **THEN** the list shows five rows numbered 1 to 5, the first two marked played, the third marked as being typed, and the last two marked queued

#### Scenario: What a row shows
- **WHEN** the session runs in `/w` and Claude edits `/w/src/routes/login.ts` with `Edit`, adding one line and removing one
- **THEN** that change's row shows `Edit`, `src/routes/login.ts` and `+1 −1`

#### Scenario: Numbers stay
- **WHEN** the user plays from an earlier change, switches grouping, or the plugin reloads
- **THEN** every row keeps the number it had

#### Scenario: Same row in either grouping
- **WHEN** the user switches from By turn to By file
- **THEN** each change's row shows the same state, number, tool, path and lines as before, under its file's group

#### Scenario: Nothing recorded yet
- **WHEN** no change has been recorded
- **THEN** the pane shows no list and no grouping buttons, and says that edits Claude makes will be typed out there

### Requirement: The changes list is grouped by turn
While By turn is chosen, the list SHALL group the kept changes into one chapter per main conversation turn, each change in the chapter of the turn it belongs to, and one chapter per replayed commit, each replayed change in its commit's chapter. Within a chapter, changes SHALL be listed in recorded order. Chapters SHALL be ordered by their earliest kept change. A turn with no kept change SHALL have no chapter.

#### Scenario: Two turns
- **WHEN** the user's first prompt leads Claude to make changes 1 to 5, and the second prompt leads to changes 6 to 9
- **THEN** the list shows a chapter for the first turn holding changes 1 to 5, then a chapter for the second holding changes 6 to 9

#### Scenario: A turn with no changes
- **WHEN** the user asks a question that Claude answers without editing, between two turns that make changes
- **THEN** the list shows chapters only for the two turns that made changes

#### Scenario: Interleaved turns
- **WHEN** a background subagent started in turn 1 records change 7 after turn 2 recorded change 6
- **THEN** change 7 is listed in turn 1's chapter, after turn 1's earlier changes, and turn 2's chapter still follows turn 1's

#### Scenario: A replay after a turn
- **WHEN** turn 1 made changes 1 to 3, and the user then replays a range of two commits that adds changes 4 to 6
- **THEN** the list shows turn 1's chapter, then a chapter for each replayed commit

### Requirement: Changes outside a known turn
Changes the plugin cannot place in a turn, because they were saved by a version that did not keep turns or were made outside any turn, SHALL be listed together in one chapter headed `Outside a turn`, with their count and a Play from first button that acts as Play turn does. Replayed changes SHALL NOT be listed there. A turn the plugin knows by id only, with no number or prompt, SHALL have a chapter headed `Earlier turn`, with its count and Play turn.

#### Scenario: Changes saved before turns were kept
- **WHEN** two changes were saved by a version that kept no turns, and the plugin reloads into this version
- **THEN** the list shows them in a chapter headed `Outside a turn`, with `2 changes` and Play from first

#### Scenario: Turn known by id only
- **WHEN** a change was recorded with its turn by a version that did not keep turn numbers or prompts, and the plugin reloads into this version
- **THEN** that change's chapter is headed `Earlier turn`, with its count and Play turn

#### Scenario: Replayed changes
- **WHEN** a replay is kept beside changes saved by a version that kept no turns
- **THEN** the `Outside a turn` chapter holds only the saved changes, and the replayed changes are in their commits' chapters

### Requirement: Show in conversation from the pane
While the pane shows a change made by a call, its header SHALL have a Show in conversation button. Each row of the changes list for a change made by a call SHALL have a ↗ button beside it. Pressing either SHALL scroll the conversation to the `Edit` or `Write` call that made that change, and SHALL NOT change playback. A replayed change SHALL have neither.

#### Scenario: From the header
- **WHEN** the pane is typing change #3 and the user presses Show in conversation
- **THEN** the conversation scrolls to the call that made change #3, and typing goes on

#### Scenario: From a row
- **WHEN** the user presses the ↗ beside change #1's row while change #3 is typing
- **THEN** the conversation scrolls to the call that made change #1, and change #3 goes on typing

#### Scenario: Nothing shown
- **WHEN** no change has been recorded
- **THEN** the pane has no Show in conversation button

#### Scenario: A replayed change
- **WHEN** the pane types a replayed change
- **THEN** the header has no Show in conversation button, and the replayed rows have no ↗
