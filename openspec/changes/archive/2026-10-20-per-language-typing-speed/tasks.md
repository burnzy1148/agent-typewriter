# Tasks

## 1. Speed resolver

- [x] 1.1 Create `src/pace.ts` with `baseCharsPerSecond(languageId, charsPerSecond, languageSpeeds)`. It returns the language's entry when that entry is a finite number greater than 0, and `charsPerSecond` otherwise. Verify: it compiles under `npm run typecheck`.
- [x] 1.2 Add `test/pace.test.ts` covering each spec scenario: nothing configured, language not listed, language listed, switching between languages, invalid values (0, negative, a string), and exact-case matching. Verify: `npm test` passes.

## 2. Setting

- [x] 2.1 Add `agentTypewriter.languageSpeeds` to `package.json` (an object of positive numbers, default `{}`), with a description that points to VS Code language IDs. Verify: the JSON is valid and `npm run typecheck` passes.
- [x] 2.2 Add `languageSpeeds: Record<string, unknown>` to `Settings` and read it in `readSettings()` with default `{}`. Verify: `npm run typecheck` passes.
- [x] 2.3 Document `languageSpeeds` in the README settings table next to `charsPerSecond`. Verify: the row appears in README.md.

## 3. Player

- [x] 3.1 Change `Player.cps(s)` to `cps(s, doc)` so it uses `baseCharsPerSecond(doc.languageId, …)` times `speedMultiplier(s)`. Update the callers in `typeText` and `deleteText`. Verify: `npm run typecheck` passes and grep shows no `cps(s)` calls without the document.

## 4. Integration verification

- [x] 4.1 Run `npm run typecheck && npm test && npm run build`. All three succeed, and the planner fuzz test still passes.

## Workflow follow-up

- Archive the change, then `bd close at-mfk.5`.
