# Tasks

## 1. Reorder buffer

- [x] 1.1 Add vscode-free `src/reorder.ts` with `ReorderBuffer` (injected clock and scheduler, `add`, `pending`, `drain`, window of `0` releases synchronously) and verify unit tests in `test/reorder.test.ts` cover out-of-order keys, ties by insertion order, and the zero window
- [x] 1.2 Implement pending-flush gating with the `key + 2 × window` cap and verify unit tests show a due item waits for an earlier pending burst and is released at the cap when that burst never finishes
- [x] 1.3 Implement per-file key forcing (`max(key, lastKey)`) and verify a unit test where a later same-file item with an earlier key is still released second
- [x] 1.4 Add the pure order-key clamp to `[firstArrival - window, lastArrival]` and verify unit tests for an mtime in the future, a very old mtime, and an in-range mtime

## 2. Setting

- [x] 2.1 Add `agentTypewriter.reorderWindowMs` to `package.json` (`["string","number"]`, default `"auto"`) and a pure resolver used by `config.ts`, and verify unit tests for `"auto"` on win32 and darwin/linux, a fixed number, `0`, and invalid values
- [x] 2.2 Add a `reorderWindowMs` row to the README settings table and a reorder step to its pipeline diagram, and verify they match the setting's default and description

## 3. Recorder wiring

- [x] 3.1 Track first and last watcher arrival per debounce burst in `recorder.ts`, register each burst as pending, compute the clamped key (mtime for create/modify, first arrival for delete), and route `record()` through the buffer with `time` set to the key; verify `npm test` and `npm run typecheck` pass
- [x] 3.2 Drain held changes in `Recorder.stop()`, expose `drainHeld()`, and call it from the `catchUp` command before `seekToEnd`; verify the existing catch-up integration section still passes

## 4. Integration checks

- [x] 4.1 Add an `it/suite.ts` section that writes `y.ts`, waits for the watcher to report it, writes `x.ts`, sets `x.ts`'s mtime earlier than `y.ts`'s with `fs.utimesSync`, and asserts the timeline and replay order is `x.ts, y.ts`; verify the section fails with `reorderWindowMs` set to `0` and passes with a fixed 5000 ms window (wide enough that the mtime clamp cannot mask slow watchers)
- [ ] 4.2 Run `npm run it` locally and on CI (Ubuntu and Windows), and verify all sections pass, including the original multi-file order check, on two consecutive Windows runs

## Workflow follow-up

- Remove the `needs-spec` label from at-net.6 and record the spec id on the bead.
- Archive the change after the PR merges, then close at-net.6.
