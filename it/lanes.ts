// Runs in two VS Code launches on a repository with a nested worktree (see
// runTest.ts). The first records the main checkout and the worktree at once,
// follows each lane, lets auto-follow and auto-record work, and leaves queued
// changes in both lanes; the second checks they were restored lane by lane.
import * as vscode from 'vscode';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import assert from 'node:assert/strict';
import type { AgentTypewriterApi } from '../src/extension';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface Expected {
  followed: string;
  pending: Record<string, number>;
  labels: string[];
}

export async function run(): Promise<void> {
  const ext = vscode.extensions.getExtension<AgentTypewriterApi>('burnzy1148.agent-typewriter');
  assert.ok(ext, 'extension not found');
  const api = await ext.activate();
  const { timeline, recorder, player } = api;
  const folder = vscode.workspace.workspaceFolders![0];
  const root = folder.uri.fsPath;
  const expectFile = process.env.IT_LANES_EXPECT!;
  async function until(what: string, fn: () => boolean, timeoutMs = 30000) {
    const start = Date.now();
    while (!fn()) {
      if (Date.now() - start > timeoutMs) {
        const lanes = timeline.laneList().map((l) => `  ${l.label} ${l.recording ? 'recording' : 'stopped'} ${timeline.pendingCount(l.id)} queued`);
        const events = timeline.all().map((e) => `  #${e.seq} ${e.kind} ${e.relPath} ${timeline.stateOf(e.seq)}`);
        console.log(`[it] timed out waiting for ${what}. Followed ${timeline.followed}\n${lanes.join('\n')}\n${events.join('\n')}\n${recorder.describeActivity()}`);
        throw new Error(`timed out waiting for ${what}`);
      }
      await sleep(50);
    }
  }
  const laneNamed = (label: string) => timeline.laneList().find((l) => l.label === label)?.id;
  const mirrorText = (rel: string) => vscode.workspace.textDocuments.find((d) => d.uri.scheme === 'agent-typewriter' && d.uri.path === '/' + rel)?.getText();

  if (process.env.IT_LANES_PHASE === 'restore') {
    const expected = JSON.parse(fs.readFileSync(expectFile, 'utf8')) as Expected;
    await api.mirrorRestore;
    assert.equal(timeline.followed, expected.followed, 'the followed lane was restored');
    for (const [lane, n] of Object.entries(expected.pending)) assert.equal(timeline.pendingCount(lane), n, `queued in ${lane}`);
    assert.deepEqual(timeline.laneList().map((l) => l.label).sort(), [...expected.labels].sort());
    assert.ok(player.isPaused, 'restored queued changes start paused');
    console.log('[it] LANES: lanes, cursors and the followed lane survive a reload ok');
    return;
  }

  const nested = path.join(root, '.worktrees', 'feat');
  const write = (file: string, text: string) => fs.writeFileSync(file, text);
  const git = (...args: string[]) =>
    execFileSync('git', ['-c', 'user.name=it', '-c', 'user.email=it@example.invalid', '-c', 'core.autocrlf=false', ...args], { cwd: root, stdio: 'ignore' });

  // --- L1. Choose the main checkout and the nested worktree together.
  await vscode.commands.executeCommand('agentTypewriter.start');
  await vscode.commands.executeCommand('agentTypewriter.chooseCheckout', folder.uri, [root, nested]);
  await until('two lanes recording', () => recorder.recordedLanes().length === 2);
  const main = folder.uri.toString();
  const feat = laneNamed('feat')!;
  assert.ok(feat, 'the worktree lane is labeled by its branch');
  assert.equal(timeline.followed, main, 'the first lane recorded is followed');
  console.log('[it] LANES: chooseCheckout with a list records two checkouts ok');

  // --- L2. Each lane records once; only the followed lane is typed.
  write(path.join(root, 'src', 'a.ts'), 'export const a = "main";\n');
  write(path.join(nested, 'src', 'a.ts'), 'export const a = "feat";\n');
  await until('both changes recorded', () => timeline.all().length === 2);
  assert.deepEqual(new Set(timeline.all().map((e) => e.lane)), new Set([main, feat]));
  const featPath = timeline.laneEvents(feat)[0].relPath;
  assert.equal(featPath, 'feat/src/a.ts');
  await until('main lane played', () => timeline.pendingCount(main) === 0 && timeline.playing === undefined);
  assert.equal(mirrorText('src/a.ts'), 'export const a = "main";\n');
  assert.equal(timeline.pendingCount(feat), 1, 'the other lane waits');
  assert.equal(mirrorText(featPath), undefined, 'nothing of the other lane was typed');
  console.log('[it] LANES: only the followed lane is typed ok');

  // --- L3. Following the other lane plays it; the first stays played.
  await vscode.commands.executeCommand('agentTypewriter.followLane', feat);
  await until('feat lane played', () => timeline.pendingCount(feat) === 0 && timeline.playing === undefined);
  assert.equal(mirrorText(featPath), 'export const a = "feat";\n');
  assert.equal(timeline.pendingCount(main), 0);
  console.log('[it] LANES: following a lane plays it ok');

  // --- L4. Auto-follow moves to the lane with queued changes once the followed one is quiet.
  await vscode.workspace.getConfiguration('agentTypewriter').update('autoFollow', true, vscode.ConfigurationTarget.Workspace);
  write(path.join(root, 'src', 'a.ts'), 'export const a = "main again";\n');
  await until('auto-follow played main', () => timeline.followed === main && timeline.pendingCount(main) === 0 && timeline.playing === undefined, 20000);
  assert.equal(mirrorText('src/a.ts'), 'export const a = "main again";\n');
  await vscode.workspace.getConfiguration('agentTypewriter').update('autoFollow', false, vscode.ConfigurationTarget.Workspace);
  console.log('[it] LANES: auto-follow tours the lanes ok');

  // --- L5. Auto-record fill gives a worktree added while recording its own lane.
  await vscode.workspace.getConfiguration('agentTypewriter').update('autoRecordWorktrees', 'fill', vscode.ConfigurationTarget.Workspace);
  git('worktree', 'add', '-q', '-b', 'extra', '.worktrees/extra');
  await until('auto-recorded lane', () => recorder.recordedLanes().length === 3);
  const extra = laneNamed('extra')!;
  await sleep(500);
  write(path.join(root, '.worktrees', 'extra', 'src', 'a.ts'), 'export const a = "extra";\n');
  await until('extra change recorded', () => timeline.laneEvents(extra).length === 1);
  assert.equal(timeline.laneEvents(extra)[0].before, 'export const a = 0;\n', 'the new lane had a baseline');
  await vscode.workspace.getConfiguration('agentTypewriter').update('autoRecordWorktrees', 'off', vscode.ConfigurationTarget.Workspace);
  console.log('[it] LANES: auto-record fill adds a lane ok');

  // --- L6. Replay never wrote the real files.
  assert.equal(fs.readFileSync(path.join(root, 'src', 'a.ts'), 'utf8'), 'export const a = "main again";\n');
  assert.equal(fs.readFileSync(path.join(nested, 'src', 'a.ts'), 'utf8'), 'export const a = "feat";\n');

  // --- L7. Leave queued changes in two lanes for the reload check.
  player.setPaused(true);
  write(path.join(root, 'src', 'b.ts'), 'export const b = 1;\n');
  await until('main change recorded', () => timeline.pendingCount(main) === 1);
  write(path.join(root, 'src', 'b.ts'), 'export const b = 2;\n');
  await until('second main change recorded', () => timeline.pendingCount(main) === 2);
  write(path.join(nested, 'src', 'b.ts'), 'export const b = "feat";\n');
  await until('feat change recorded', () => timeline.pendingCount(feat) === 1);
  await vscode.commands.executeCommand('agentTypewriter.followLane', feat);
  assert.equal(timeline.pendingCount(feat), 1);
  await vscode.commands.executeCommand('agentTypewriter.stop');
  await api.store?.flush();
  const expected: Expected = {
    followed: feat,
    pending: { [main]: 2, [feat]: 1 },
    labels: timeline.laneList().map((l) => l.label),
  };
  fs.writeFileSync(expectFile, JSON.stringify(expected));
  console.log('[it] LANES: queued changes left in two lanes ok');
}
