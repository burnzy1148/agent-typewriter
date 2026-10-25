# Design

## Context

`planHunks(before, after)` returns hunks in document order, each offset relative to the text after earlier hunks, and `Player.play` types them one by one through `typeHunk`: navigate (scroll, then arrow-key walk or click), delete, type. `src/highlights.ts` also calls `planHunks`, for leaf diffs inside `netHunks`, and relies on its hunks being in document order so each offset is also a position in the final text. Line diffs from `diffLines` usually give a new function, method or object literal to one hunk whose `insertText` holds the whole block, opening and closing lines included (checked with the class-method, sibling-function and nested-object cases).

The read pause and scroll in `Player.scrollTo` run whenever the target line is outside the view and `smooth` is set. While typing, `typeText` keeps the caret in view with `revealRange(InCenterIfOutsideViewport)` on each line break, so the caret is often on the last visible line.

## Goals / Non-Goals

**Goals:**
- The behavior in `specs/authoring-order/spec.md` and the `edit-navigation` delta.
- Applying the reordered hunks to the before text gives the after text exactly, each offset relative to the text after earlier hunks. The fuzz test covers the reordered plan.
- The caret never leaves the text the current edit is typing, so reordering adds no scroll and no read pause.

**Non-Goals:**
- Reordering across hunks (imports added last, a helper written after its caller). Those move the view across the file and need their own read-pause story.
- Single-line pairs, quotes, and language keywords (`begin`/`end`, `do`/`done`).
- Changing `planHunks` or the diff itself.

## Decisions

### A separate pass after `planHunks`

`authoringOrder(hunks, after)` in `src/planner.ts` takes `planHunks`' output and returns a new list. `planHunks` keeps its contract, so `highlights.ts`, which needs document order, is untouched, and the reordering can be tested and turned off on its own. The player composes the two when `naturalOrder` is on.

Alternative: an option on `planHunks`. Rejected because its only other caller must not get it, and `planHunks` already takes a positional `maxLineEdits`.

### Blocks found by indentation, not by a bracket stack

An opener is `{`, `[` or `(` immediately followed by a line break in the hunk's `insertText`. Its line's indentation is that line's leading whitespace, read from `after` when the line starts before the hunk (hunks in document order make `after.slice(0, offset)` the text before the hunk). The opener's block closes at the first later non-blank line that is not deeper (deeper: longer leading whitespace that starts with the opener line's) when that line has exactly the same indentation and starts with the matching bracket. Anything else, or reaching the end of `insertText`, means no block.

One pass over the lines with a stack of open candidates finds every block: each non-blank line pops the candidates it is not deeper than, matching or failing each, and then pushes itself if it ends with an opener. It is linear in the text, and the blocks it finds nest properly.

Why: brackets in strings, comments, regexes and prose break a bracket stack unless it knows each language's lexical rules. Indentation is what agents and formatters produce, and requiring the closer at the opener's exact indentation makes false matches rare. A false match costs only an odd order, never wrong text. Alternatives considered: a bracket counter with string and comment skipping (language-specific and still fooled by `'` in Rust lifetimes or English text), and VS Code's bracket-pair API (needs a live document and a language, while the planner is vscode-free).

### Pieces, and why the closer piece starts at a line break

The hunk's `insertText` T is split into contiguous pieces, typed in this order for a block with opener at `o` and its closing line starting after the line break at `n`:

1. T[cur, o + 1): everything up to and including the opener.
2. T[n, e): the line break, the closing line's indentation, the closer, and the rest of the closing line with its line break, unless that rest ends with an opener of its own (`} else {`), which is then left for step 4. `e` is clamped to the end of the enclosing range.
3. The body T[o + 1, n), handled the same way recursively.
4. Continue from `e`.

Starting the closer piece at the line break keeps the closer on its own line while the body is typed: the body is inserted at the end of the opening line, after `{` and before `\n}`, the way pressing Enter between auto-closed braces leaves the caret. Splitting at the closer instead would show `  body;}` while the body's first line is typed.

Typing the rest of the closing line with the closer (`};`, `})`, `},` and the line break) matches what a person types when closing a block; a trailing `else {` starts its own block, so it is left out.

Pieces 1 and 2 sit next to each other in the document when typed, so they become one hunk. Each other piece is its own hunk. A hunk's `deleteText` stays on its first piece. Empty bodies are not split.

### Offsets in O(1) per piece

While a body is typed, the only already-typed text after the caret is the closer pieces of the blocks it is inside. So a piece's offset is the hunk's offset plus the length typed so far minus the total length of the open blocks' closer pieces. That keeps the pass linear even for a big new file.

Round trip: every piece is a contiguous range of T, the ranges cover T exactly once, and each is inserted after exactly the typed ranges that precede it in T. So the document ends with T at the hunk's offset, as the original hunk would leave it, and later hunks' offsets are unchanged. The fuzz test checks this rather than trusting the argument.

### Only multi-line blocks

Each extra hunk costs a caret move and the 220 ms settle before typing. Doing `print()` then `total` for every call would add that to every bracket in a change while looking almost the same as typing left to right. Multi-line blocks are where the order is visible and where people most clearly work outside in.

### Continuation pieces skip the read pause and the scroll

Every piece after a hunk's first carries `continues: true` on its `Hunk`. The player navigates to it with `smooth` still on for the arrow-key walk, but tells `scrollTo` not to wait or scroll: a target outside the view is revealed at once with `InCenterIfOutsideViewport`, as `typeText` does for the caret.

Why: these moves stay within the text being typed. Going back into the body goes up one or two lines, and carrying on after the body goes down past closing lines just typed. But the body often ends on the last visible line with its `}` pushed just below, and without this the next piece would wait 1.5 s for the read pause and then scroll two lines. Alternative: treat any edit a few lines outside the view as in view, for all hunks. Rejected as a change to specified behavior for edits that have nothing to do with this feature.

### On by default, behind `agentTypewriter.naturalOrder`

The extension's purpose is to look like a person typing, and the other realism behaviors (`arrowNavigation`, `smoothScroll`, `highlightAdditions`) are on by default with a switch to turn them off. This follows them: `naturalOrder`, boolean, default `true`, read per change in `play()`, accepted in the repository settings file. A boolean rather than an enum, since the patterns are one behavior to the user; later patterns can join it. The general integration workspaces set it to `false` so their timing checks keep the plain top-to-bottom order, and a dedicated section in `it/suite.ts` turns it on.

## Risks / Trade-offs

- [A diff splits a block across hunks, for example a method added at the end of a class aligned onto the old closing brace] → that hunk is typed top to bottom, as today. No sliding of hunks to find a better alignment in this change.
- [A false match on odd indentation, such as a multi-line string] → only the order differs; the round trip is guaranteed and fuzzed.
- [More hunks per change, so more short pauses] → only one extra caret move and settle per block, and only for multi-line blocks. Catch-up speed shortens them as usual.
- [Finish current mid-change] → unchanged: the loop stops and the rest of the after text is written at once.

## Migration Plan

None. Setting `naturalOrder` to `false` restores the old order.
