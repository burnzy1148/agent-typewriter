# Proposal

## Why

at-o3z.18 drew the band above the prompt before lanes had a say in its look. With several lanes holding changes, its line counts the followed lane's queue and ` · N in other lanes`, but never says which lane it is typing, so `2 queued` and `up to date` have no owner. The pane's header names the followed lane by its color and label (at-o3z.15), and the at-o3z.8 mockup's Desktop board (pane closed) draws a lane color dot on the band. Bead at-o3z.32.

## What Changes

- **The shared line names the followed lane.** While more than one lane holds a kept change, the line the band and the status entry share puts the followed lane's label right after `Agent Typewriter`: `Agent Typewriter · write tests · typing limiter.ts #3 · 2 queued · 1 in other lanes`. The label is cut to 16 characters with an ellipsis, as a row's lane tag is. With one lane, the line reads as it does today.
- **The band draws the followed lane's color.** On the band, the label is preceded by a dot in the lane's color, as in the pane's header. The status entry is plain text, so it carries the label alone.
- The counts keep their meaning and wording: `N queued` is the named lane's, `N in other lanes` the rest.

Out of scope, and kept possible:
- The agent type in parentheses that the header adds after a subagent's label. The band is one row beside three buttons; the pane, one press away, shows it.
- A lane dot on the band while only one lane holds changes. The mockup draws one in every state; the pane names no lane then, and the band follows the pane.
- Following another lane from the band. Lane chips stay in the pane.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `claude-code-replay`: *The band and the status entry share one line* (added by at-o3z.18) gains the followed lane's label while more than one lane holds a kept change; a new requirement has the band draw the lane's color before the label. Requires at-o3z.18's change to be archived first.

## Impact

- `claude-code/hooks/replay.ts`: `bandOf` adds the followed lane's label to the line and returns the lane's color; the condition and the lane lookup are shared with `viewOf`'s header lane so the two cannot disagree.
- `claude-code/types/index.d.ts`: `Band` gains an optional `lane` (`{ label, color }`). The `band` atom's shape tag moves from `band-1` to `band-2`.
- `claude-code/hooks/register.tsx`: the `AbovePrompt` hook draws `Agent Typewriter · `, the colored dot, and the rest of the line. The status entry is unchanged in code: it reads `band.line`.
- `test/claudeCodeReplay.test.ts`, `claude-code/tests/band.test.tsx`: the new wording, the single-lane case, the cut label, and the dot.
- `claude-code/README.md`: the band's description mentions the lane.
- No shared module (`core.mjs`) changes; `saved`, `view` and `listing` keep their shapes.
