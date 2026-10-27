// Runs on a repository whose branch `pr` holds a diff (see runTest.ts), with
// auto-record `fill`, auto-follow on and no ignore patterns. A worktree
// auto-record picks up is watched but gets no lane until it records a change:
// a review worktree made, read and removed again and again leaves no lane, a
// git checkout inside one is no change, and an agent's first write gives its
// worktree a lane that auto-follow then moves to.
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
    execFileSync('git', ['-c', 'user.name=it', '-c', 'user.email=it@example.invalid', '-c', 'core.autocrlf=false', ...args], { cwd, stdio: 'pipe' })
      .toString()
      .trim();
  async function until(what: string, fn: () => boolean, timeoutMs = 30000) {
    const start = Date.now();
    while (!fn()) {
      if (Date.now() - start > timeoutMs) {
        const lanes = timeline.laneList().map((l) => `  ${l.label} ${l.recording ? 'recording' : 'stopped'} ${timeline.pendingCount(l.id)} queued`);
        const events = timeline.all().map((e) => `  #${e.seq} ${e.kind} ${e.relPath}`);
        console.log(`[it] timed out waiting for ${what}. Followed ${timeline.followed}\n${lanes.join('\n')}\n${events.join('\n')}\n${recorder.describeActivity()}`);
        throw new Error(`timed out waiting for ${what}`);
      }
      await sleep(50);
    }
  }
  // Both spellings: VS Code may resolve a symlink the workspace was opened through.
  const realRoot = fs.realpathSync.native(root);
  const watched = (file: string) => [file, path.join(realRoot, path.relative(root, file))].some((f) => recorder.hasBaseline(vscode.Uri.file(f)));
  /** The lanes the status bar counts for the folder, from a fresh listing. */
  const statusLanes = async () => (await api.refreshCheckouts()).get(main)?.lanes;
  // The folder's own scope names nested worktrees as skipped while git lists any.
  const listsNested = () => recorder.describeFilter().includes('other worktrees skipped');

  await vscode.commands.executeCommand('agentTypewriter.start');
  await until('main recording', () => recorder.recordedLanes().length === 1);

  // --- W1. A review worktree made, read and removed three times gets no lane any time.
  const review = path.join(root, '.claude', 'worktrees', 'review-1');
  const reviewFile = path.join(review, 'src', 'a.ts');
  for (let i = 0; i < 3; i++) {
    git(root, 'worktree', 'add', '-q', '--detach', review, 'main');
    await until(`review worktree watched (${i + 1})`, () => watched(reviewFile));
    assert.equal(fs.readFileSync(reviewFile, 'utf8'), 'export const a = 0;\n');
    assert.equal(recorder.recordedLanes().length, 1, 'not ticked in the Checkouts view');
    assert.equal(timeline.laneList().length, 1, 'no lane');
    assert.equal(await statusLanes(), 1, 'not in the status count');
    git(root, 'worktree', 'remove', '--force', review);
    await until(`review worktree gone (${i + 1})`, () => !listsNested() && !watched(reviewFile));
  }
  assert.deepEqual(timeline.all(), []);
  console.log('[it] WAITING: a review worktree made and removed three times gets no lane ok');

  // --- W2. A git checkout in a waiting worktree is no first change.
  const review2 = path.join(root, '.claude', 'worktrees', 'review-2');
  const review2File = path.join(review2, 'src', 'a.ts');
  git(root, 'worktree', 'add', '-q', '--detach', review2, 'main');
  await until('second review worktree watched', () => watched(review2File));
  git(review2, 'checkout', '-q', 'pr');
  assert.equal(fs.readFileSync(review2File, 'utf8'), 'export const a = "pr";\n');
  await sleep(3000);
  assert.deepEqual(
    timeline.all().map((e) => e.relPath),
    [],
    'the checkout recorded nothing',
  );
  assert.equal(recorder.recordedLanes().length, 1);
  git(root, 'worktree', 'remove', '--force', review2);
  await until('second review worktree gone', () => !listsNested() && !watched(review2File));
  console.log('[it] WAITING: a git checkout in a waiting worktree gives it no lane ok');

  // --- W3. An agent's first write gives its worktree a lane, from the checked-out text, and auto-follow moves there.
  const fix = path.join(root, '.worktrees', 'fix');
  const fixFile = path.join(fix, 'src', 'a.ts');
  git(root, 'worktree', 'add', '-q', '-b', 'fix', fix);
  await until('fix watched', () => watched(fixFile));
  assert.equal(timeline.laneList().length, 1, 'no lane before its first change');
  fs.writeFileSync(fixFile, 'export const a = "fix";\n');
  await until('fix lane with its change', () => timeline.laneList().some((l) => l.label === 'fix' && timeline.laneEvents(l.id).length === 1));
  const fixLane = timeline.laneList().find((l) => l.label === 'fix')!;
  assert.equal(timeline.laneEvents(fixLane.id)[0].before, 'export const a = 0;\n');
  assert.equal(recorder.recordedLanes().length, 2);
  assert.equal(await statusLanes(), 2);
  await until('auto-follow moves to fix', () => timeline.followed === fixLane.id && timeline.pendingCount(fixLane.id) === 0 && timeline.playing === undefined);
  assert.equal(fs.readFileSync(fixFile, 'utf8'), 'export const a = "fix";\n', 'replay never wrote the real file');
  console.log('[it] WAITING: a first write gives a worktree its lane ok');

  await vscode.commands.executeCommand('agentTypewriter.stop');
  git(root, 'worktree', 'remove', '--force', fix);
}
