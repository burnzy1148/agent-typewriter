// Second VS Code launch on the workspace suite.ts left behind (see runTest.ts).
// Checks that the timeline came back from workspace storage like a reload would.
import * as vscode from 'vscode';
import * as fs from 'node:fs';
import * as path from 'node:path';
import assert from 'node:assert/strict';
import type { AgentTypewriterApi } from '../src/extension';
import { persisted } from './suite';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function until(what: string, fn: () => boolean, timeoutMs = 30000) {
  const start = Date.now();
  while (!fn()) {
    if (Date.now() - start > timeoutMs) throw new Error(`timed out waiting for ${what}`);
    await sleep(50);
  }
}

export async function run(): Promise<void> {
  const ext = vscode.extensions.getExtension<AgentTypewriterApi>('local.agent-typewriter');
  assert.ok(ext, 'extension not found');
  const api = await ext.activate();
  const { timeline, player } = api;
  const root = vscode.workspace.workspaceFolders![0].uri.fsPath;
  const disk = (rel: string) => fs.readFileSync(path.join(root, rel), 'utf8');
  const mirrorText = (rel: string) =>
    vscode.workspace.textDocuments.find((d) => d.uri.scheme === 'agent-typewriter' && d.uri.path === '/' + rel)?.getText();
  const idle = () => timeline.pendingCount() === 0 && !timeline.all().some((e) => timeline.stateOf(e.seq) === 'playing');
  const expected = JSON.parse(fs.readFileSync(process.env.IT_EXPECT!, 'utf8'));

  // --- 1. Same changes, same recorded text, same queue; playback paused.
  assert.deepEqual(timeline.all().map(persisted), expected.events, 'restored changes differ from the recorded ones');
  assert.equal(timeline.pendingCount(), expected.pending, 'queued count not restored');
  assert.ok(player.isPaused, 'playback is not paused with queued changes');
  await sleep(500);
  assert.equal(timeline.pendingCount(), expected.pending, 'restored changes played while paused');
  assert.equal(mirrorText('src/queued1.ts'), undefined, 'a mirror was typed into while paused');
  assert.ok(api.store, 'no timeline store');
  assert.ok(!path.resolve(api.store.path).startsWith(path.resolve(root)), 'timeline saved inside the workspace');
  console.log(`[it] restore ok: ${timeline.all().length} changes, ${timeline.pendingCount()} queued, paused`);

  // --- 2. Resuming plays the queued changes in order.
  const order: string[] = [];
  timeline.onDidChange(() => {
    const p = timeline.all().find((e) => timeline.stateOf(e.seq) === 'playing');
    if (p && order[order.length - 1] !== p.relPath) order.push(p.relPath);
  });
  await vscode.commands.executeCommand('agentTypewriter.togglePause');
  await until('restored queue to play', idle);
  assert.deepEqual(order, ['src/queued1.ts', 'src/queued2.ts'], 'restored queue played out of order');
  for (const rel of ['src/queued1.ts', 'src/queued2.ts']) assert.equal(mirrorText(rel), disk(rel), `mirror for ${rel} does not match disk`);
  console.log('[it] resume after restore ok');
}
