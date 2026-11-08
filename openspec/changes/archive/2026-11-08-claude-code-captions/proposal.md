# Proposal

## Why

The pane types each change but says nothing about why Claude made it. The words the agent wrote just before an `Edit` or `Write` call ("Now I'll guard the login route with it and answer 429 when the bucket is empty.") are the best caption that change has, and today the person has to scroll the conversation to find them. The at-o3z.8 mockup shows them over the code while the change types, and in a hover card on the change's row. at-o3z.12 gave each change its `tool_use_id`, turn and agent, which is what this needs to find the right words in the right loop.

## What Changes

- **Each change keeps its narration.** The plugin watches the rows each loop of the session keeps (the main conversation's, and each subagent's or teammate's, told apart by agent) and, for each `Edit` or `Write` call, keeps the visible text the agent wrote in the same response before that call, after any earlier call in it. A call with no text of its own that comes straight after another call in the same response shares that call's caption. Thinking is never a caption, and text from an earlier response never carries over. A change with no such text has no caption.
- **The caption over the code.** While the pane shows a change that has a caption, it shows the caption in quotes between the header and the code, in italics on a muted band, cut with an ellipsis to fit three lines. The code gives up those rows. A change with no caption draws no band.
- **A hover card on the row.** On a surface with a pointer, resting on a change's row in the list shows a card with that change's caption, cut to fit the card. A row whose change has no caption shows no card.
- **Captions survive a reload**, and changes saved by an earlier version load with no caption.
- Reading the rows never changes them and never holds up the conversation.

Out of scope, and kept possible:
- The VS Code extension's captions (at-3hc.3), which read the transcript file instead.
- Chapters by turn (at-o3z.13) and lanes (at-o3z.15). Captions do not depend on either.
- The terminal, where the plugin still draws nothing.
- Rendering Markdown in a caption: it is shown as plain text.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `claude-code-replay`: adds requirements for keeping each change's narration from its own loop, showing it over the code, the hover card on a row, captions across a reload, loading changes saved without captions, and reading rows without affecting the conversation. No existing requirement's text changes.

## Impact

- `claude-code/hooks/replay.ts`: `Change` gains an optional `caption`; a pure narration tracker (per loop: text since the last call, the run's last caption) that turns rows into `tool_use_id` → caption; `View` gains the shown change's caption and `Row` its caption cut for the card; helpers that cut a caption to a number of lines and columns.
- `claude-code/hooks/register.tsx`: an observe-only `session.append` hook on response rows feeds the tracker; `record()` attaches a waiting caption when it enqueues, and a caption that arrives after its change is attached then; the pane draws the caption band and each row's hover card.
- `claude-code/types/index.d.ts`: `View` and `Row` gain `caption`; the `text` family gains a `<change id>:caption` member; `view` moves to `view-2` and `listing` to `listing-3` (*superseded in implementation:* `listing-4`; see design.md, *Corrected in implementation*). `saved` keeps `saved-4`.
- `claude-code/tests/` and `test/claudeCodeReplay.test.ts`: tests for the tracker, the band, the card, the reload.
- `claude-code/README.md`: captions. `site/` has no page on the plugin's pane today.
- No shared module (`core.mjs`) changes.
