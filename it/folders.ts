// Runs in a VS Code launch on a saved multi-root workspace (see runTest.ts).
// Checks that folders added or removed while recording are picked up.
import * as vscode from 'vscode';
import * as fs from 'node:fs';
import * as path from 'node:path';
import assert from 'node:assert/strict';
import type { AgentTypewriterApi } from '../src/extension';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function run(): Promise<void> {
  const ext = vscode.extensions.getExtension<AgentTypewriterApi>('burnzy1148.agent-typewriter');
  assert.ok(ext, 'extension not found');
  const api = await ext.activate();
  const { timeline, recorder } = api;
  const multi = process.env.IT_MULTI!;
  const dir = (name: string) => path.join(multi, name);
  async function until(what: string, fn: () => boolean, timeoutMs = 20000) {
    const start = Date.now();
    while (!fn()) {
      if (Date.now() - start > timeoutMs) {
        console.log(`[it] timed out waiting for ${what}. Recorder activity:\n${recorder.describeActivity()}`);
        throw new Error(`timed out waiting for ${what}`);
      }
      await sleep(50);
    }
  }
  // Both spellings of a path: the temp folder can sit behind a symlink (/var on macOS).
  const spellings = (name: string, rel: string) =>
    [dir(name), fs.realpathSync.native(dir(name))].map((d) => vscode.Uri.file(path.join(d, rel)));
  const hasBaseline = (name: string, rel: string) => spellings(name, rel).some((u) => recorder.hasBaseline(u));
  const matches = (name: string, rel: string) => spellings(name, rel).some((u) => recorder.matches(u));
  const folderNamed = (name: string) => vscode.workspace.workspaceFolders?.find((f) => f.name === name);
  const folderCount = () => vscode.workspace.workspaceFolders?.length ?? 0;
  const since = (from: number) => timeline.all().slice(from);

  await vscode.commands.executeCommand('agentTypewriter.start');
  await until('a and b baselines', () => hasBaseline('a', 'src/x.ts') && hasBaseline('b', 'src/x.ts'));

  // --- 1. A folder added while recording is recorded like the ones there at start.
  assert.ok(vscode.workspace.updateWorkspaceFolders(folderCount(), 0, { uri: vscode.Uri.file(dir('c')) }), 'could not add folder c');
  await until('folder c open', () => !!folderNamed('c'));
  await until('folder c recorded', () => matches('c', 'src/x.ts') && hasBaseline('c', 'src/x.ts'));
  const atAdd = timeline.all().length;
  fs.writeFileSync(path.join(dir('c'), 'src', 'x.ts'), "export const x = 'c';\nexport const added = 1;\n");
  await until('change in the added folder', () => since(atAdd).some((e) => e.relPath === 'c/src/x.ts'));
  const addEvent = since(atAdd).find((e) => e.relPath === 'c/src/x.ts')!;
  assert.equal(addEvent.kind, 'modify');
  assert.equal(addEvent.before, "export const x = 'c';\n", 'the added folder change does not start from its baseline');
  console.log('[it] folder added while recording ok');

  // --- 2. A removed folder's chosen worktree is no longer recorded.
  await vscode.commands.executeCommand('agentTypewriter.chooseCheckout', folderNamed('b')!.uri, dir('b-feature'));
  await until('b-feature chosen', () => recorder.checkoutOf(folderNamed('b')!)?.own === false);
  await until('b-feature baseline', () => hasBaseline('b-feature', 'src/x.ts'));
  const atRemove = timeline.all().length;
  const bIndex = vscode.workspace.workspaceFolders!.findIndex((f) => f.name === 'b');
  assert.ok(bIndex > 0, 'folder b is not a non-first folder');
  assert.ok(vscode.workspace.updateWorkspaceFolders(bIndex, 1), 'could not remove folder b');
  await until('folder b closed', () => !folderNamed('b'));
  await until('b-feature no longer recorded', () => !matches('b-feature', 'src/x.ts') && !hasBaseline('b-feature', 'src/x.ts'));
  fs.writeFileSync(path.join(dir('b-feature'), 'src', 'x.ts'), "export const x = 'b';\nexport const afterRemove = 1;\n");
  await sleep(1500);
  recorder.drainHeld();
  assert.deepEqual(
    since(atRemove).map((e) => `${e.kind} ${e.relPath}`),
    [],
    "a removed folder's chosen worktree was still recorded",
  );
  assert.equal(timeline.all().length, atRemove, 'changes already recorded were dropped');
  console.log("[it] removed folder's worktree ok");

  // --- 3. A removed folder that records its own checkout drops its baselines.
  const watched = recorder.watchedCount;
  const cIndex = vscode.workspace.workspaceFolders!.findIndex((f) => f.name === 'c');
  assert.ok(vscode.workspace.updateWorkspaceFolders(cIndex, 1), 'could not remove folder c');
  await until('folder c closed', () => !folderNamed('c'));
  await until('folder c baselines dropped', () => !hasBaseline('c', 'src/x.ts'));
  assert.ok(recorder.watchedCount < watched, 'watchedCount did not fall');
  assert.equal(matches('c', 'src/x.ts'), false);
  console.log('[it] removed folder ok');

  await vscode.commands.executeCommand('agentTypewriter.stop');
}
