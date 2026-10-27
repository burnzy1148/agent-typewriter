// Runs on a repository with no .claude folder yet (see runTest.ts). On Linux,
// VS Code's watcher reports a folder tree made several levels deep at once as
// its top folder alone and reports nothing written below it later (at-net.15),
// so the recorder watches those folders itself. Writes there, a while after the
// tree was made, are recorded: in the folder's own checkout, in a folder deleted
// and made again or only chmod-ed, and in a lane on a worktree added the way
// agent tools add theirs.
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
  /** Waits until the recorder has heard nothing for `ms`, for at most 15 s. */
  async function quiet(ms = 1000) {
    const start = Date.now();
    let last = recorder.describeActivity();
    let since = Date.now();
    while (Date.now() - since < ms && Date.now() - start < 15000) {
      await sleep(100);
      const now = recorder.describeActivity();
      if (now !== last) [last, since] = [now, Date.now()];
    }
  }

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

  // --- G5. A folder deleted and made again at once, as a code generator does, then a write in it a second later.
  fs.mkdirSync(path.join(root, 'gen', 'api', 'v1'), { recursive: true });
  write('gen/api/v1/one.ts', 'export const one = 1;\n');
  await until('one.ts created', () => events().includes('create gen/api/v1/one.ts'));
  await sleep(1000);
  fs.rmSync(path.join(root, 'gen', 'api'), { recursive: true });
  fs.mkdirSync(path.join(root, 'gen', 'api', 'v1'), { recursive: true });
  write('gen/api/v1/two.ts', 'export const two = 2;\n');
  await until('the old file deleted and the new one created', () => events().includes('delete gen/api/v1/one.ts') && events().includes('create gen/api/v1/two.ts'));
  await sleep(1000);
  write('gen/api/v1/two.ts', 'export const two = 3;\n');
  await until('two.ts modified', () => events().includes('modify gen/api/v1/two.ts'));
  console.log('[it] DEEP: a write in a folder deleted and made again is recorded ok');

  // --- G6. The same folder's attributes changed (chmod), which reads like it was made again: nothing is recorded, and a later write is.
  const before = events().length;
  fs.chmodSync(path.join(root, 'gen', 'api', 'v1'), 0o700);
  fs.chmodSync(path.join(root, 'gen', 'api'), 0o700);
  await sleep(1000);
  write('gen/api/v1/two.ts', 'export const two = 4;\n');
  await until('two.ts modified again', () => events().length > before);
  await sleep(500);
  assert.deepEqual(events().slice(before), ['modify gen/api/v1/two.ts']);
  console.log('[it] DEEP: a chmod of a watched folder records nothing, and a write after it is recorded ok');

  // --- G4. git worktree add .claude/worktrees/x with no .claude yet, recorded by hand, then a write in it.
  // The lane starts once the checkout's own events have stopped coming: one late on Windows reads as a new file.
  const x = path.join(root, '.claude', 'worktrees', 'x');
  git(root, 'worktree', 'add', '-q', '-b', 'x', x);
  await quiet();
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
