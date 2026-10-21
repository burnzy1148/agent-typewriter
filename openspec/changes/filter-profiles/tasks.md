# Tasks

## 1. Profile model

- [ ] 1.1 Add `src/profiles.ts` with `parseProfiles`, `mergeProfiles`, and `activeProfileOf`; verify unit tests in `test/profiles.test.ts` cover a valid profile, a non-object profile, an invalid entry kept out while the rest applies, unknown keys in a profile, merge precedence by name, and an unknown active name
- [ ] 1.2 Add `profiles` and `activeProfile` to `package.json` (with a nested schema), `REPO_SETTING_KINDS` (new `string` and `profiles` kinds), and `schemas/agent-typewriter.schema.json`; make `parseRepoSettings` report problems inside profiles; verify `npm test` including the settings sync test

## 2. Resolution

- [ ] 2.1 In `readSettings`, merge `profiles` by name across user, file, and workspace, resolve `activeProfile`, and put the active profile between the file and workspace for the four filter keys; add `activeProfile` and `profiles` to `Settings`; verify `npm run typecheck` and a unit test of the resolution order through `pickLayer`

## 3. Commands and status

- [ ] 3.1 Add **Switch Filter Profile...** (quick pick or name argument; sets `activeProfile` and clears workspace values of the profile's keys) and **Save Filters as Profile...** (input box or name argument; confirms before replacing a workspace profile; saves and activates) to `package.json` and `src/extension.ts`, with `...` menu entries
- [ ] 3.2 Refresh filters when `profiles` or `activeProfile` change, log an unknown active name, and prefix `recorder.describeFilter()` with the active profile's name
- [ ] 3.3 Add a README Profiles section: format, where profiles come from, precedence, the two commands, what switching clears

## 4. Integration checks

- [ ] 4.1 Add an integration section: a file-defined profile is activated with the switch command while a workspace `extensions` value exists, that value is cleared, the panel description shows the name, the profile's filters apply to the next writes, "No profile" restores the previous filters, and saving creates and activates a workspace profile; verify `npm run it` passes locally and on CI (Ubuntu and Windows)

## Workflow follow-up

- Archive on the PR branch once tasks are done and CI is green, then merge.
- Close at-kbn.4 after the merge.
