// Runs in a VS Code launch on a repository with a `feature` branch that is
// not checked out (see runTest.ts). Replays main..feature while watching:
// watching stops, the changes come from the commits in order, playback types
// them into mirrors, and the repository and working tree stay untouched.
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
  const { timeline, recorder, player } = api;
  const root = vscode.workspace.workspaceFolders![0].uri.fsPath;
  const git = (...args: string[]) => execFileSync('git', ['--no-optional-locks', ...args], { cwd: root, encoding: 'utf8' });
  const mirrorText = (rel: string) =>
    vscode.workspace.textDocuments.find((d) => d.uri.scheme === 'agent-typewriter' && d.uri.path === '/' + rel)?.getText();
  const idle = () => timeline.pendingCount() === 0 && !timeline.all().some((e) => timeline.stateOf(e.seq) === 'playing');
  async function until(what: string, fn: () => boolean, timeoutMs = 30000) {
    const start = Date.now();
    while (!fn()) {
      if (Date.now() - start > timeoutMs) {
        console.log(`[it] timed out waiting for ${what}. Recorder activity:\n${recorder.describeActivity()}`);
        throw new Error(`timed out waiting for ${what}`);
      }
      await sleep(50);
    }
  }

  // Watch, and record one live change so the replay has a buffer to replace.
  await vscode.commands.executeCommand('agentTypewriter.start');
  await until('watching', () => recorder.isRunning);
  // Give the watcher time to start, as the other suites do (Windows can miss an early create).
  await sleep(1000);
  fs.writeFileSync(path.join(root, 'src/live.ts'), 'export const live = 1;\n');
  await until('live change recorded', () => timeline.all().some((e) => e.relPath === 'src/live.ts'));
  await until('live change played', idle);

  const head = git('rev-parse', 'HEAD');
  const status = git('status', '--porcelain=v1', '-z');
  const refs = git('for-each-ref');
  const index = fs.readFileSync(path.join(root, '.git', 'index'));
  const disk = fs.readFileSync(path.join(root, 'src/a.ts'), 'utf8');

  // An invalid range is refused and leaves everything as it was.
  const before = timeline.all().map((e) => e.seq);
  await vscode.commands.executeCommand('agentTypewriter.replayGit', { range: 'main..no-such-branch' });
  assert.deepEqual(timeline.all().map((e) => e.seq), before, 'an invalid range changed the buffer');
  assert.ok(recorder.isRunning, 'an invalid range stopped watching');

  await vscode.commands.executeCommand('agentTypewriter.replayGit', { range: 'main..feature' });
  assert.equal(recorder.isRunning, false, 'replaying did not stop watching');
  assert.ok(player.isPaused, 'replay did not start paused');
  const show = (t: string) => t.replace(/\r\n/g, '\n');
  assert.deepEqual(
    timeline.all().map((e) => [e.kind, e.relPath, show(e.before), show(e.after)]),
    [
      ['modify', 'src/a.ts', 'export const a = 1;\n', 'export const a = 2;\n'],
      ['create', 'src/b.ts', '', 'export const b = 1;\n'],
      ['modify', 'src/a.ts', 'export const a = 2;\n', 'export const a = 3;\nexport const twice = a * 2;\n'],
      ['delete', 'src/gone.ts', 'export const gone = true;\n', ''],
    ],
    'replayed changes differ from the branch commits (notes.txt must be filtered out)',
  );
  assert.equal(timeline.pendingCount(), 4, 'replayed changes are not all pending');
  console.log('[it] git replay: main..feature built from history, watching stopped, paused');

  await vscode.commands.executeCommand('agentTypewriter.resume');
  await until('replay played', idle);
  assert.equal(show(mirrorText('src/a.ts') ?? ''), 'export const a = 3;\nexport const twice = a * 2;\n', 'src/a.ts mirror does not end at the branch text');
  assert.equal(show(mirrorText('src/b.ts') ?? ''), 'export const b = 1;\n', 'src/b.ts mirror does not end at the branch text');

  // Wait past the watcher's debounce: had anything been written, it would show up in git.
  await sleep(500);
  assert.equal(git('rev-parse', 'HEAD'), head, 'HEAD moved');
  assert.equal(git('status', '--porcelain=v1', '-z'), status, 'the working tree or index changed');
  assert.equal(git('for-each-ref'), refs, 'refs changed');
  assert.deepEqual(fs.readFileSync(path.join(root, '.git', 'index')), index, 'the index file was rewritten');
  assert.equal(fs.readFileSync(path.join(root, 'src/a.ts'), 'utf8'), disk, 'src/a.ts on disk changed');
  assert.ok(!fs.existsSync(path.join(root, 'src/b.ts')), 'src/b.ts was written to disk');
  console.log('[it] git replay: typed into mirrors, repository untouched');

  // Asked to play, as a replay picked from the menus does, it types without a resume.
  await vscode.commands.executeCommand('agentTypewriter.pause');
  await vscode.commands.executeCommand('agentTypewriter.replayGit', { range: 'feature', play: true });
  assert.equal(player.isPaused, false, 'a replay asked to play started paused');
  assert.deepEqual(
    timeline.all().map((e) => [e.kind, e.relPath]),
    [
      ['modify', 'src/a.ts'],
      ['delete', 'src/gone.ts'],
    ],
    'the single-commit replay holds other changes',
  );
  await until('playing replay finished', idle);
  assert.equal(show(mirrorText('src/a.ts') ?? ''), 'export const a = 3;\nexport const twice = a * 2;\n', 'src/a.ts mirror does not end at the commit text');
  console.log('[it] git replay: plays right away when asked');
}
