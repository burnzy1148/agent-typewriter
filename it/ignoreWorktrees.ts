// Runs on a repository whose branch `pr` holds a diff (see runTest.ts), with
// auto-record `fill`, auto-follow on, and autoIgnoreWorktrees naming
// review-style worktrees. Review tools make a detached worktree and write a
// diff into it; those must get no lane and record nothing, while any other
// new worktree still gets one, until a pattern added mid-run stops it.
import * as vscode from 'vscode';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
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
  /** Long enough for a worktree listing and any writes to settle; nothing should happen meanwhile. */
  const quiet = () => sleep(3000);

  await vscode.commands.executeCommand('agentTypewriter.start');
  await until('main recording', () => recorder.recordedLanes().length === 1);

  // --- I1. A detached review worktree in the folder, with the PR diff applied as plain writes.
  const review = path.join(root, '.claude', 'worktrees', 'review-1');
  git(root, 'worktree', 'add', '-q', '--detach', review, 'main');
  await quiet();
  const patch = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'atpatch-')), 'pr.patch');
  fs.writeFileSync(patch, git(root, 'diff', 'main', 'pr') + '\n');
  git(review, 'apply', patch);
  await quiet();
  assert.equal(recorder.recordedLanes().length, 1, 'the review worktree got no lane');
  assert.equal(timeline.all().length, 0, 'nothing from it was recorded');
  console.log('[it] IGNORE: a review worktree in the folder gets no lane ok');

  // --- I2. A review worktree in a temp directory, with files copied in.
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tmp.'));
  fs.rmSync(tmp, { recursive: true });
  git(root, 'worktree', 'add', '-q', '--detach', tmp, 'main');
  await quiet();
  fs.copyFileSync(path.join(review, 'src', 'a.ts'), path.join(tmp, 'src', 'a.ts'));
  fs.copyFileSync(path.join(review, 'src', 'new.ts'), path.join(tmp, 'src', 'new.ts'));
  await quiet();
  assert.equal(recorder.recordedLanes().length, 1, 'the temp worktree got no lane');
  assert.equal(timeline.all().length, 0);
  console.log('[it] IGNORE: a temp-dir review worktree gets no lane ok');

  // --- I3. Recorded by hand, the review worktree gets a lane, but auto-follow never moves to it.
  fs.writeFileSync(path.join(root, 'src', 'a.ts'), 'export const a = "main";\n');
  await until('main change played', () => timeline.pendingCount(main) === 0 && timeline.all().length === 1 && timeline.playing === undefined);
  await recorder.addCheckout(folder, review);
  await until('review lane', () => recorder.recordedLanes().length === 2);
  const reviewLane = timeline.laneList().find((l) => l.id !== main)!;
  await sleep(500);
  fs.writeFileSync(path.join(review, 'src', 'a.ts'), 'export const a = "review";\n');
  await until('review change queued', () => timeline.pendingCount(reviewLane.id) === 1);
  // Past auto-follow's quiet period, with only the ignored lane holding a change.
  await sleep(4000);
  assert.equal(timeline.followed, main, 'auto-follow left the ignored lane queued');
  assert.equal(timeline.pendingCount(reviewLane.id), 1);
  await recorder.removeCheckout(folder, review);
  await until('review lane stopped', () => recorder.recordedLanes().length === 1);
  console.log('[it] IGNORE: auto-follow never moves to an ignored lane ok');

  // --- I4. Any other new worktree still gets a lane.
  git(root, 'worktree', 'add', '-q', '-b', 'fix', path.join(root, '.worktrees', 'fix'));
  await until('fix lane', () => recorder.recordedLanes().length === 2);
  const fix = timeline.laneList().find((l) => l.label === 'fix')!;
  assert.ok(fix, 'the fix lane is labeled by its branch');
  await sleep(500);
  fs.writeFileSync(path.join(root, '.worktrees', 'fix', 'src', 'a.ts'), 'export const a = "fix";\n');
  await until('fix change recorded', () => timeline.laneEvents(fix.id).length === 1);
  console.log('[it] IGNORE: a worktree no pattern names still gets a lane ok');

  // --- I5. A pattern added mid-run stops that lane; its change stays.
  await vscode.workspace
    .getConfiguration('agentTypewriter')
    .update('autoIgnoreWorktrees', ['**/.claude/worktrees/review-*', 'tmp.*', 'fix'], vscode.ConfigurationTarget.Workspace);
  await until('fix lane stopped', () => recorder.recordedLanes().length === 1 && timeline.laneInfo(fix.id)?.recording === false);
  assert.equal(timeline.laneEvents(fix.id).length, 1, 'its change is kept');
  console.log('[it] IGNORE: a pattern added mid-run stops an auto-recorded lane ok');

  await vscode.commands.executeCommand('agentTypewriter.stop');
  for (const w of [review, tmp, path.join(root, '.worktrees', 'fix')]) git(root, 'worktree', 'remove', '--force', w);
}
