# Design

## Context

`Player.cps(s)` in `src/player.ts` computes the typing rate as `s.charsPerSecond × speedMultiplier(s)`. `typeText`, `deleteText`, and `delayAfter` all get their rate from `cps()`, so the base speed is chosen in this one place. Mirror documents are opened with `openTextDocument`, so VS Code assigns their `languageId` from the file extension. Unit tests are bundled without `vscode` as an external, so any logic they test must not import `vscode` (`config.ts` does).

## Goals / Non-Goals

**Goals:**
- One pure function picks the base speed for a language, and unit tests cover it.
- Every place that uses `cps()` gets the per-language speed automatically.

**Non-Goals:**
- Tuning jitter, pause lengths, or the file-switch delay per language.
- A command or UI for editing the map. Users edit it in VS Code settings.

## Decisions

### Store absolute speeds, not multipliers

`languageSpeeds` values are characters per second, like `charsPerSecond`. That way `"markdown": 60` means exactly what it says. Multipliers (for example `"markdown": 1.7`) were considered: they would follow changes to `charsPerSecond`, but they are harder to reason about, and the bead asks for "different base speeds".

### Put the resolver in a new `src/pace.ts`

`baseCharsPerSecond(languageId, charsPerSecond, languageSpeeds)` returns the entry for that language if it is a finite number greater than 0, and `charsPerSecond` otherwise. Keeping it in its own vscode-free module lets `npm test` import it. The alternatives were putting it in `config.ts`, which imports `vscode`, or in `planner.ts`, which is about diffs, not pacing.

### Validate when the speed is used, not when settings are read

`readSettings()` copies the raw object, and the resolver ignores bad entries. That keeps all the validation in one function that tests cover. It also handles hand-edited settings that don't follow the JSON schema.

### Pass the document to `cps()`

`cps(s)` becomes `cps(s, doc)`. Its callers in `typeText` and `deleteText` already hold `editor.document`, and `delayAfter` receives `cps` as an argument, so the pause after each chunk scales automatically. Other delays that only use `speedMultiplier()`, such as the file-switch delay and the pause before a selection, stay the same for every language, which matches the non-goals.

## Risks / Trade-offs

- [Language ID typos such as `"Markdown"` silently do nothing] → The setting's description points users to the language IDs shown in VS Code's language picker. Matching is exact, as the spec requires.
- [The language a mirror document gets can differ from the real file's if VS Code associations differ] → This is acceptable. Both are assigned from the same file extension in the same window.
