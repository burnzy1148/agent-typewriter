# Spec Delta

## Purpose

Defines which workspace paths Agent Typewriter records, so replay shows the files a user cares about and leaves out the rest.

## ADDED Requirements

### Requirement: Optionally skip gitignored paths
When `agentTypewriter.respectGitignore` is `true`, a path that git reports as ignored in its workspace folder SHALL NOT be recorded or given a baseline. This SHALL apply in addition to the extension, exclude, and include filters. The setting SHALL default to `false`, which records ignored paths as before.

#### Scenario: Ignored file skipped
- **WHEN** the setting is on, `.gitignore` contains `*.log`, and `build.log` is written
- **THEN** no change is recorded for `build.log`

#### Scenario: Setting off
- **WHEN** the setting is off and an ignored file that passes the other filters is written
- **THEN** its change is recorded

#### Scenario: Ignored directory
- **WHEN** the setting is on, `.gitignore` contains `generated/`, and a new file is created under `generated/`
- **THEN** no change is recorded for it

### Requirement: Ignored means what git reports
A path SHALL count as ignored exactly when git would ignore it as an untracked file: patterns from `.gitignore` files at any level, `.git/info/exclude`, and the global excludes file. A file git tracks SHALL NOT count as ignored even when it matches an ignore pattern.

#### Scenario: Tracked file matching a pattern
- **WHEN** the setting is on, `.gitignore` contains `*.cfg`, and the committed file `app.cfg` is modified
- **THEN** the change is recorded

#### Scenario: New file matching a pattern
- **WHEN** the setting is on, recording has started, and a file that did not exist at start and matches an ignore pattern is created
- **THEN** no change is recorded for it

### Requirement: Ignore rules apply live
Turning the setting on or off, or changing a `.gitignore` file in the workspace, SHALL take effect while recording without restarting it. Files that become ignored SHALL stop being recorded; files that stop being ignored SHALL get a baseline so their next change is recorded.

#### Scenario: Editing .gitignore while watching
- **WHEN** the setting is on, recording is on, and `notes/` is appended to `.gitignore`
- **THEN** later changes under `notes/` are not recorded

#### Scenario: Turning the setting off while watching
- **WHEN** recording is on with the setting on and the user turns it off
- **THEN** the next change to a previously ignored file that passes the other filters is recorded as a modify from its baseline

### Requirement: Without git the setting has no effect
When git cannot run, or a workspace folder is not inside a git repository, the setting SHALL have no effect for that folder, and the output channel SHALL say so once per recording session. The extension SHALL only read git state and SHALL NOT modify the repository.

#### Scenario: Folder outside a repository
- **WHEN** the setting is on and the workspace folder is not in a git repository
- **THEN** changes are filtered as if the setting were off
- **AND** the output channel reports that gitignore rules are not applied for that folder
