# Proposal

## Why

Replay types every change strictly top to bottom. A person writing a new block does not: they type the opening line, close the block right away (or the editor closes it for them), and then fill in the body between. When an agent adds a function, replay shows its body growing with no closing brace in sight until the very last line, which reads as a machine printing text rather than someone writing code. This is bead `at-mfk.3` in the "Typing realism" epic.

## What Changes

- Within one typed edit, a multi-line bracket block (an opening `{`, `[` or `(` at the end of a line, closed by the matching bracket at the start of a later line with the same indentation) is typed outside in: the opening line, then the closing line, then the body between them.
- Blocks nest. A block's header, including any multi-line bracket pairs inside it such as a parameter list spread over several lines, is complete before its body is typed, so a function's signature always comes before its body.
- Moving the caret back into a block to type its body, and past its closing line afterwards, never waits for the read pause or scrolls: a few lines are brought into view the way typing keeps the caret in view.
- Edits are still played in document order relative to each other; only the order inside one edit changes. The mirror's text at the end of each change is unchanged.
- New setting `agentTypewriter.naturalOrder` (default `true`). Off, every edit is typed top to bottom as before.
- Single-line bracket pairs (`foo(bar)`), language keywords, and moving edits around in the file (for example adding an import last) are out of scope.

## Capabilities

### New Capabilities
- `authoring-order`: the order in which replay types the text of a change, including blocks typed outside in and headers before bodies.

### Modified Capabilities
- `edit-navigation`: moving the caret within a block that is typed outside in skips the read pause and the scroll.

## Impact

- `src/planner.ts`: a new `authoringOrder` step splits each hunk's inserted text into pieces in authoring order, with each piece's offset relative to the text after earlier pieces. `planHunks` itself is unchanged, so `src/highlights.ts` is unaffected.
- `test/planner.test.ts`: unit tests for the patterns and the fuzz test extended to random block-structured text in authoring order.
- `src/player.ts`: applies `authoringOrder` when the setting is on, and navigates to continuation pieces without the read pause or a scroll.
- `src/config.ts`, `src/repoSettings.ts`, `package.json`, `schemas/agent-typewriter.schema.json`: the new setting. The site's settings page is generated from `package.json`.
- CHANGELOG, and the "Diff planning" part of the site's How it works page.
- `it/runTest.ts` turns the setting off in the general integration workspaces so their timing stays as before; `it/suite.ts` gets a section that turns it on.
