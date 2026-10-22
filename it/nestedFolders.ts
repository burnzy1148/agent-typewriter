// Runs in a VS Code launch on a saved workspace whose folders nest (see
// runTest.ts): [repo, repo/pkg], outer folder first. A file in the inner
// folder takes its git baseline from its own committed text.
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
  const repo = process.env.IT_NEST!;
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
  const hasBaseline = (rel: string) =>
    [repo, fs.realpathSync.native(repo)].some((d) => recorder.hasBaseline(vscode.Uri.file(path.join(d, rel))));
  assert.deepEqual(
    vscode.workspace.workspaceFolders?.map((f) => f.name),
    ['repo', 'pkg'],
    'the outer folder is not listed first',
  );

  await vscode.commands.executeCommand('agentTypewriter.start');
  await until('baselines', () => hasBaseline('package.json') && hasBaseline('pkg/package.json'));
  assert.equal(recorder.watchedCount, 2, 'a file of the inner folder was baselined twice');
  const at = timeline.all().length;
  fs.writeFileSync(path.join(repo, 'pkg', 'package.json'), '{ "name": "PKG", "version": "2" }\n');
  await until('inner change recorded', () => timeline.all().length > at);
  await sleep(500);
  recorder.drainHeld();
  const events = timeline.all().slice(at);
  assert.deepEqual(
    events.map((e) => [e.kind, e.relPath, e.before]),
    [['modify', 'pkg/package.json', '{ "name": "PKG" }\n']],
    "the inner folder's file was recorded from the outer folder's committed text",
  );
  console.log('[it] REC2: nested workspace folders ok');
  await vscode.commands.executeCommand('agentTypewriter.stop');
}
