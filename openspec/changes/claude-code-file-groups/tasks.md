# Tasks

Start only once at-o3z.13 (`claude-code-turn-chapters`) is merged into `claude-code-extension`: rebase onto it and check the delta's MODIFIED blocks against its archived spec text first.

## 1. Groups by file as data

- [ ] 1.1 In `claude-code/hooks/replay.ts`, add `fileGroupsOf(listing)` (group rows by `path` as recorded, rows in listing order, groups by first row) and `fileHeaderLabel(group, name, width)` (file name, folder cut first with `…`, `1 change` / `<n> changes`, sharing at-o3z.13's count wording). Unit-test in `test/claudeCodeReplay.test.ts`: three files with one edited twice, a file edited again after a later file's first change staying in place, a subagent's and a main-loop change to one file in one group, the same name in two folders as two groups, the dropped-but-playing row in its file's group, a file outside the session folder, a long folder cut before the name, and `1 change`. Verify with `npm test`.

## 2. The switch and the file groups in the pane

- [ ] 2.1 In `claude-code/types/index.d.ts`, add `grouping: Shaped<'turn' | 'file'>` to `PluginState`. In `claude-code/hooks/register.tsx`, add the `grouping` atom (`grouping-1`, initial `'turn'`), and on the `Changes` line draw `By turn` and `By file` Buttons keyed `group:turn` / `group:file` (chosen one `variant="primary"`, the other `variant="secondary"` and `dimColor`, labels naming the state). Pressing the other one saves the choice, clears `live.listTop` and redraws. Add plugin tests in `claude-code/tests/groups.test.tsx`: By turn selected at first, switching to By file and back, the change being typed going on after a switch, no buttons before the first change, the choice surviving a reload, and a scrolled list brought back to the current row by a switch. Verify with `npm run check:claude-code`.
- [ ] 2.2 In `register.tsx`, when `grouping` is `'file'`, build the list's lines from `fileGroupsOf`: a header line per group (bold file name, dim folder, dim count, a plain Button keyed `play-file:<path>` reading Play from first) and its rows, through the same window and scroll code as chapters. Play from first seeks to the group's first row and makes the list follow again. Add plugin tests in `groups.test.tsx`: headers and rows for three files, Play from first while playing (later changes of other files follow) and while paused (row reads Next, file shown as before), a file whose first changes were dropped, the dropped note above the first group, a scrolled list brought back by Play from first, and rows numbered and drawn the same in both groupings. Verify with `npm run check:claude-code`.
- [ ] 2.3 In `claude-code/README.md`, describe the By turn / By file switch, file groups and Play from first, next to at-o3z.13's chapters. Check `site/src/content/docs/` for pages describing the plugin's changes list and update them to match. Verify by reading the sections.

## 3. Integration

- [ ] 3.1 Run `npm run typecheck`, `npm test`, `npm run typecheck:claude-code`, `npm run check:claude-code`, and `openspec validate claude-code-file-groups --strict`. All pass.

## Workflow follow-up

- Add the switch (are `primary` / `secondary` clear enough as selected?) and file group headers to at-o3z.28's desktop check.
- Open a PR into `claude-code-extension`, turn on Auto-fix, and run the review cycle.
- Archive the change on the PR branch once its tasks are done and CI is green, after `claude-code-turn-chapters` is archived, so `openspec/specs/claude-code-replay/spec.md` lands with the code.
- Do not merge; the maintainer merges. Close at-o3z.27 after the merge.
