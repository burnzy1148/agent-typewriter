# Tasks

## 1. Git access

- [x] 1.1 Add `src/gitIgnore.ts` with `IgnoredPaths` (exact files and `dir/` prefixes), parsing of `ls-files --others --ignored --exclude-standard --directory -z`, `listIgnored(folder, run)`, and `checkIgnored(folder, path, run)` treating exit 1 as not ignored; verify unit tests in `test/gitIgnore.test.ts` cover directory prefixes (not matching `dirx/`), nested paths, exit 0/1, not-a-repo, and git missing

## 2. Setting

- [x] 2.1 Add `respectGitignore` to `package.json`, `config.ts`, `REPO_SETTING_KINDS`, and the schema, and to the README Filtering section; verify `npm test` (the settings sync test) and `npm run typecheck` pass

## 3. Recorder

- [x] 3.1 Snapshot ignored paths per folder in `captureBaseline` and `refreshFilter` when the setting is on, log once per session per folder when git can't help, and route every filter check through `passes(uri)`; verify existing integration sections pass
- [x] 3.2 In `flush`, check a file with no baseline and no snapshot entry with `checkIgnored` before recording or baselining it, and cache the result
- [x] 3.3 Schedule `refreshFilter` on `.gitignore` events while the setting is on, and call `refreshFilter` from `applySettingsChange` when `respectGitignore` changes

- [x] 3.4 Fix a race the integration section hit on CI: a baseline capture still running when a file is created could snapshot it before its watcher event and swallow the create. `captureBaseline` now skips files modified after it started; verify CI passes on Ubuntu and Windows

## 4. Integration checks

- [x] 4.1 Add an integration section: with the setting on, a new file matching an ignore pattern is not recorded, a committed file matching a pattern is, appending a directory to `.gitignore` while watching stops recording under it, and turning the setting off records the next change to a previously ignored file as a modify; verify `npm run it` passes locally and on CI (Ubuntu and Windows)

## Workflow follow-up

- Archive on the PR branch once tasks are done and CI is green, then merge.
- Close at-kbn.3 after the merge.
