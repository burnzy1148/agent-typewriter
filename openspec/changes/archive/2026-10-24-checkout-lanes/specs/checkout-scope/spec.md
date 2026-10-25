# Spec Delta

## MODIFIED Requirements

### Requirement: A folder records only its own checkout by default
When a workspace folder is in a git repository and the user has not chosen other checkouts for it, a path inside another worktree of that repository SHALL NOT be recorded or given a baseline, even when the worktree sits inside the folder, unless auto-record gives that worktree its own lane. A path inside a worktree that records in its own lane SHALL be recorded only in that lane. This SHALL apply in addition to the extension, exclude, include, and gitignore filters.

#### Scenario: Write in a nested worktree
- **WHEN** the main checkout is open, recording is on, auto-record is off, a worktree of the same repository exists at `.claude/worktrees/feature`, and an agent writes `.claude/worktrees/feature/src/a.ts`
- **THEN** no change is recorded for it

#### Scenario: Write in the folder's own checkout
- **WHEN** the same setup holds and an agent writes `src/a.ts` in the main checkout
- **THEN** the change is recorded as before

#### Scenario: No baselines for nested worktrees
- **WHEN** recording starts in a main checkout that contains three nested worktrees, none of them chosen
- **THEN** none of the files inside those worktrees get a baseline or count against the baseline budget

#### Scenario: Nested worktree in its own lane
- **WHEN** the main checkout and the nested worktree `.claude/worktrees/feature` both record and an agent writes `.claude/worktrees/feature/src/a.ts`
- **THEN** one change is recorded, in the `feature` lane, as `feature/src/a.ts`

### Requirement: Worktree changes apply while recording
Adding or removing a worktree of the folder's repository while recording SHALL take effect without restarting. A worktree added inside a recorded checkout SHALL stop being recorded as part of that checkout, and SHALL get its own lane when auto-record allows it. Removing a worktree SHALL NOT affect changes already in the timeline.

#### Scenario: Agent creates a worktree while recording
- **WHEN** recording is on in the main checkout, auto-record is off, and an agent runs `git worktree add .worktrees/fix`, then writes files there
- **THEN** no changes are recorded for files under `.worktrees/fix`

#### Scenario: Agent creates a worktree with auto-record
- **WHEN** the same happens with auto-record set to `fill` and fewer than five lanes recording
- **THEN** the writes under `.worktrees/fix` are recorded in a new `fix` lane, not in the main checkout's lane

### Requirement: Choosing a checkout
The user SHALL be able to choose, per workspace folder, which checkouts of its repository are recorded: any set of the folder's own checkout and the other worktrees git lists, whether inside the folder or elsewhere on disk, within the five-lane cap. The choice SHALL list each checkout with its branch, or its short commit when detached, and its path, and mark the ones recorded. Only the chosen checkouts SHALL be recorded for the folder. Choosing none SHALL be refused.

#### Scenario: Watch a sibling worktree
- **WHEN** the main checkout is open, a worktree exists at `../repo-feature`, the user chooses only it, and an agent writes `src/a.ts` in it
- **THEN** the change is recorded and replayed
- **AND** writes to `src/a.ts` in the main checkout are not recorded

#### Scenario: Watch the main checkout and a worktree
- **WHEN** the user chooses both the main checkout and `../repo-feature`, and agents write `src/a.ts` in each
- **THEN** both changes are recorded, each in its own lane

#### Scenario: Watch a nested worktree
- **WHEN** the user chooses the worktree at `.claude/worktrees/feature` and an agent writes `src/a.ts` in it
- **THEN** the change is recorded with the path `src/a.ts` relative to that worktree, labelled with the worktree's name

#### Scenario: Filters apply within the chosen checkout
- **WHEN** the include filter is `src/**` and the user has chosen another worktree
- **THEN** only files under that worktree's `src/` are recorded

#### Scenario: Multi-root workspace
- **WHEN** two workspace folders are open, each in a git repository with more than one worktree, and the user runs the command
- **THEN** the user first picks which folder the choice is for

#### Scenario: Choose nothing
- **WHEN** the user clears every checkout in the command's picker and accepts
- **THEN** a message says at least one checkout must record, and the recorded checkouts are unchanged

### Requirement: The chosen checkout is shown
While recording, the status bar SHALL show the followed lane's checkout when more than one checkout records or the one recorded is not the folder's own, and the Checkouts view SHALL show every recorded checkout. Selecting the status bar entry SHALL offer the checkout choice.

#### Scenario: Another worktree chosen
- **WHEN** recording is on with only the worktree on branch `feature` chosen
- **THEN** the status bar shows `feature` as the watched checkout

#### Scenario: Two checkouts recorded
- **WHEN** the main checkout on `main` and the worktree on `feature` both record and `feature` is followed
- **THEN** the status bar shows `feature` and that two checkouts record

### Requirement: Switching checkouts applies while recording
Adding or removing a recorded checkout while recording SHALL take effect without restarting. Files in an added checkout SHALL get baselines so their next change is recorded, files in a removed one SHALL stop being recorded, and changes already in the timeline SHALL stay as they are.

#### Scenario: Switch while changes are queued
- **WHEN** recording is on, two changes from the main checkout are queued, and the user chooses another worktree in place of the main checkout
- **THEN** the two queued changes stay in the main checkout's lane and are played when it is followed
- **AND** the next change in the chosen worktree is recorded as a modify from its baseline

#### Scenario: Add a checkout
- **WHEN** recording is on in the main checkout and the user adds the worktree `feature`
- **THEN** the main checkout keeps recording, and the next change in `feature` is recorded as a modify from its baseline

### Requirement: The choice is remembered
The chosen checkouts and the followed lane SHALL be remembered per workspace folder across window reloads. A remembered choice of a single checkout, from before lanes, SHALL be read as that one checkout. If a remembered worktree no longer exists when recording starts or while recording, its lane SHALL stop. When that leaves the folder with no recorded checkout, the folder SHALL record its own checkout instead. In both cases the output channel SHALL say so.

#### Scenario: Reload
- **WHEN** the user chooses the main checkout and a worktree, reloads the window, and starts recording
- **THEN** both are recorded and the same lane is followed

#### Scenario: Chosen worktree removed
- **WHEN** only a chosen worktree records and it is removed with `git worktree remove` while recording
- **THEN** recording continues in the folder's own checkout
- **AND** the output channel reports the fallback

#### Scenario: One of two removed
- **WHEN** the main checkout and the worktree `feature` record and `feature` is removed with `git worktree remove`
- **THEN** the main checkout keeps recording, and the `feature` lane is shown as stopped with its changes kept
