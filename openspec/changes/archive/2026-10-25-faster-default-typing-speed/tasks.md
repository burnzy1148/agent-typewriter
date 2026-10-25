# Tasks

## 1. Default speed

- [x] 1.1 Set `DEFAULT_CHARS_PER_MINUTE` in `src/pace.ts` to 1000, and the `charsPerMinute` default in `package.json` and `schemas/agent-typewriter.schema.json` to 1000; verify `npm test`
- [x] 1.2 Change the `languageSpeeds` description example in `package.json` and `schemas/agent-typewriter.schema.json` to `{ "markdown": 1500, "json": 1200 }`
- [x] 1.3 Add a unit test that the `package.json` and schema `charsPerMinute` defaults equal `DEFAULT_CHARS_PER_MINUTE`

## 2. Tests

- [x] 2.1 In `test/pace.test.ts`, use 1000 as the base speed and 1500 for the Markdown examples, and expect the 1000 default from `resolveCharsPerMinute`; use 1500 in `test/repoSettings.test.ts`; verify `npm test`
- [x] 2.2 In `it/suite.ts`, expect the 1000 default when `charsPerMinute` is not a number; verify `npm run it`

## 3. Docs

- [x] 3.1 Use a non-default `charsPerMinute` (600) in the site repository-settings example, and add a CHANGELOG entry under Unreleased
