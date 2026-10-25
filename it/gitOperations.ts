// Runs in a VS Code launch on a repository whose main branch is behind
// `feature` and conflicts with `clash` (see runTest.ts). While recording, a
// fast-forward merge records nothing, an agent edit after it records from the
// merged text, and a conflicted merge records only the resolution.
import * as vscode from 'vscode';
import { execFileSync } from 'node:child_process';
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
  const root = vscode.workspace.workspaceFolders![0].uri.fsPath;
  const git = (...args: string[]) =>
    execFileSync('git', ['-c', 'user.name=it', '-c', 'user.email=it@example.invalid', '-c', 'core.autocrlf=false', ...args], {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  const show = (t: string) => t.replace(/\r\n/g, '\n');
  const changes = () => timeline.all().map((e) => [e.kind, e.relPath, show(e.before), show(e.after)]);
  async function until(what: string, fn: () => boolean, timeoutMs = 30000) {
    const start = Date.now();
    while (!fn()) {
      if (Date.now() - start > timeoutMs) {
        console.log(`[it] timed out waiting for ${what}. Changes: ${JSON.stringify(changes())}\nRecorder activity:\n${recorder.describeActivity()}`);
        throw new Error(`timed out waiting for ${what}`);
      }
      await sleep(50);
    }
  }

  await vscode.commands.executeCommand('agentTypewriter.start');
  await until('watching', () => recorder.isRunning);
  // Give the watcher time to start, as the other suites do (Windows can miss an early create).
  await sleep(1000);

  // A fast-forward merge changes src/a.ts and adds src/c.ts: nothing is recorded.
  git('merge', '-q', '--ff-only', 'feature');
  // Past the debounce and Windows' reorder window, so the merge's writes are read before the next write.
  await sleep(3500);
  assert.deepEqual(changes(), [], 'the merge was recorded');
  const merged = show(fs.readFileSync(path.join(root, 'src/a.ts'), 'utf8'));
  fs.writeFileSync(path.join(root, 'src/a.ts'), `${merged}export const agent = 1;\n`);
  await until('agent edit recorded', () => timeline.all().length > 0);
  await sleep(500);
  assert.deepEqual(changes(), [['modify', 'src/a.ts', merged, `${merged}export const agent = 1;\n`]], 'the agent edit after the merge');
  git('commit', '-q', '-am', 'agent');
  console.log('[it] git operations: fast-forward merge skipped, the next edit recorded from the merged text');

  // A conflicted merge writes markers into src/a.ts: nothing is recorded until the resolution.
  assert.throws(() => git('merge', '-q', 'clash'));
  const markers = show(fs.readFileSync(path.join(root, 'src/a.ts'), 'utf8'));
  assert.match(markers, /<<<<<<</);
  await sleep(3500);
  assert.equal(timeline.all().length, 1, `the conflicted merge was recorded: ${JSON.stringify(changes())}`);
  fs.writeFileSync(path.join(root, 'src/a.ts'), 'export const a = "resolved";\n');
  await until('resolution recorded', () => timeline.all().length > 1);
  await sleep(500);
  assert.deepEqual(changes()[1], ['modify', 'src/a.ts', markers, 'export const a = "resolved";\n'], 'the resolution');
  assert.equal(timeline.all().length, 2);
  console.log('[it] git operations: conflict markers skipped, the resolution recorded from them');

  await vscode.commands.executeCommand('agentTypewriter.stop');
}
