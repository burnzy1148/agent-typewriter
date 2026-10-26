// Runs on a repository with no .claude folder yet (see runTest.ts). On Linux,
// VS Code's watcher reports a folder tree made several levels deep at once as
// its top folder alone and reports nothing written below it later (at-net.15),
// so the recorder watches those folders itself. Writes there, a while after the
// tree was made, are recorded: in the folder's own checkout, and in a lane on
// a worktree added the way agent tools add theirs.
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
  const folder = vscode.workspace.workspaceFolders![0];
  const root = folder.uri.fsPath;
  const main = folder.uri.toString();
  const git = (cwd: string, ...args: string[]) =>
    execFileSync('git', ['-c', 'user.name=it', '-c', 'user.email=it@example.invalid', '-c', 'core.autocrlf=false', ...args], { cwd, stdio: 'pipe' });
  const events = (lane = main) => timeline.laneEvents(lane).map((e) => `${e.kind} ${e.relPath}`);
  async function until(what: string, fn: () => boolean, timeoutMs = 30000) {
    const start = Date.now();
    while (!fn()) {
      if (Date.now() - start > timeoutMs) {
        const all = timeline.all().map((e) => `  #${e.seq} ${e.kind} ${e.relPath}`);
        console.log(`[it] timed out waiting for ${what}\n${all.join('\n')}\n${recorder.describeActivity()}`);
        throw new Error(`timed out waiting for ${what}`);
      }
      await sleep(50);
    }
  }
  const write = (rel: string, text: string) => fs.writeFileSync(path.join(root, rel), text);

  await vscode.commands.executeCommand('agentTypewriter.start');
  await until('main recording', () => recorder.recordedLanes().length === 1);

  // --- G1. mkdir -p with a file written at once, then later a write to it and a new file.
  fs.mkdirSync(path.join(root, 'a', 'b', 'c'), { recursive: true });
  write('a/b/c/one.ts', 'export const one = 1;\n');
  await until('one.ts created', () => events().includes('create a/b/c/one.ts'));
  await sleep(1000);
  write('a/b/c/one.ts', 'export const one = 2;\n');
  write('a/b/c/two.ts', 'export const two = 2;\n');
  await until('later writes recorded', () => events().includes('modify a/b/c/one.ts') && events().includes('create a/b/c/two.ts'));
  console.log('[it] DEEP: writes in a tree made by mkdir -p are recorded ok');

  // --- G2. mkdir -p with nothing in it, and a file written a second later.
  fs.mkdirSync(path.join(root, 'd', 'e', 'f'), { recursive: true });
  await sleep(1000);
  write('d/e/f/x.ts', 'export const x = 1;\n');
  await until('x.ts created', () => events().includes('create d/e/f/x.ts'));
  console.log('[it] DEEP: a file written later in an empty deep tree is recorded ok');

  // --- G3. A tree moved in whole, and a write in it a second later.
  const outside = `${root}-moved`;
  fs.mkdirSync(path.join(outside, 'm', 'n'), { recursive: true });
  fs.writeFileSync(path.join(outside, 'm', 'n', 'k.ts'), 'export const k = 1;\n');
  fs.renameSync(outside, path.join(root, 'moved'));
  await until('k.ts created', () => events().includes('create moved/m/n/k.ts'));
  await sleep(1000);
  write('moved/m/n/k.ts', 'export const k = 2;\n');
  await until('k.ts modified', () => events().includes('modify moved/m/n/k.ts'));
  console.log('[it] DEEP: a write in a tree moved in is recorded ok');

  // --- G4. git worktree add .claude/worktrees/x with no .claude yet, recorded by hand, then a write in it.
  // The lane starts once the checkout's own events have come: one late on Windows reads as a new file.
  const x = path.join(root, '.claude', 'worktrees', 'x');
  git(root, 'worktree', 'add', '-q', '-b', 'x', x);
  await sleep(1000);
  await recorder.addCheckout(folder, x);
  await until('x lane', () => recorder.recordedLanes().length === 2);
  const lane = timeline.laneList().find((l) => l.id !== main && l.recording)!;
  await sleep(500);
  fs.writeFileSync(path.join(x, 'src', 'a.ts'), 'export const a = "x";\n');
  await until('worktree change recorded', () => events(lane.id).length === 1);
  assert.deepEqual(events(lane.id), ['modify x/src/a.ts']);
  console.log('[it] DEEP: a lane on a worktree added under a new .claude sees its writes ok');

  await vscode.commands.executeCommand('agentTypewriter.stop');
  git(root, 'worktree', 'remove', '--force', x);
}
