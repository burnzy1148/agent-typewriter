# Tasks

## 1. The shared line

- [ ] 1.1 In `claude-code/hooks/replay.ts`, add `followedLane(deck)` (undefined unless more than one lane holds a kept change; else the followed lane's label, color slot, and agent type when it is not the label) and use it in `viewOf` for the header's `lane`, with no change to `view`. Verify with `npm test` (the header's lane tests pass unchanged).
- [ ] 1.2 In `bandOf`, when `followedLane` is defined, put `laneTagText(label)` right after `BAND_PREFIX` and return `lane: { label: <cut label>, color }`. In `claude-code/types/index.d.ts`, add the optional `lane` to `Band`. Unit-test in `test/claudeCodeReplay.test.ts` every scenario of the modified *The band and the status entry share one line* and *How the band and the status entry name the lane*'s long label, update the existing other-lanes assertions to the new wording, and pin that a lane-naming line starts with `${BAND_PREFIX} · ${lane.label} · `. Verify with `npm test`.

## 2. The band

- [ ] 2.1 In `claude-code/hooks/register.tsx`, move the `band` atom to `band-2`. In the `AbovePrompt` hook, when `b.lane` is set, draw inside the one truncating `Text`: `${BAND_PREFIX} · `, a `●` in `laneColor(b.lane.color)`, a space, and `b.line.slice(BAND_PREFIX.length + 3)`; else `b.line` as now. Add plugin tests in `claude-code/tests/band.test.tsx` for every scenario of *How the band and the status entry name the lane* (dot color and placement, the status entry's words without a dot, the dot following a lane switch, no dot with one lane), and update *Only another lane waits* to the line naming `Main`. Verify with `npm run check:claude-code`.
- [ ] 2.2 In `claude-code/README.md`, say the band and the status entry name the followed lane while several lanes hold changes, with the lane's color on the band. Verify by reading the section.

## 3. Integration

- [ ] 3.1 Run `npm run typecheck`, `npm test`, `npm run typecheck:claude-code`, `npm run check:claude-code`, and `openspec validate claude-code-band-lane --strict`. All pass.

## 4. Archive order

- [ ] 4.1 Before archiving, confirm `openspec/specs/claude-code-replay/spec.md` holds at-o3z.18's *The band and the status entry share one line* (`claude-code-prompt-band` archived). If any change archived since this one was written modified that requirement, fold its text into this MODIFIED block. Verify `openspec validate claude-code-band-lane --strict` reports no archive refusal.

## Workflow follow-up

- Add the band with two lanes (dot and label) to at-o3z.28's desktop check.
- Open a PR into `claude-code-extension`, turn on Auto-fix, and run the review cycle.
- Archive the change on the PR branch once its tasks are done and CI is green.
- Do not merge; the maintainer merges. Close at-o3z.32 after the merge.
