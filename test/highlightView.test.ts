import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HighlightView } from '../src/highlightView';
import type { Player } from '../src/player';
import { Timeline } from '../src/timeline';
import * as vscode from 'vscode';

test('a file slow to diff while typed does not keep later files from the clear buttons', async () => {
  const t = new Timeline(100);
  const push = (relPath: string, before: string, after: string) =>
    t.push({ uri: 'file:///w/' + relPath, relPath, time: 0, kind: 'modify', before, after, eol: '\n', linesAdded: 0, linesRemoved: 0 });
  const playAll = () => {
    for (let e = t.peek(); e; e = t.peek()) t.complete(e.seq, t.begin(e.seq));
  };
  // big.ts comes first, and diffing it against its baseline takes well over a pass's budget.
  const pool = Array.from({ length: 8 }, (_, i) => `r,0,${i},0\n`);
  const big1 = Array.from({ length: 8000 }, (_, i) => pool[(i * 5 + (i >> 3)) % 8]).join('');
  const big2 = big1.split(/(?<=\n)/).map((l, i) => (i % 8 === 3 ? 'changed\n' : l)).join('');
  push('big.ts', '', big1);
  playAll();
  t.clearHighlights('big.ts');
  push('big.ts', big1, big2);
  push('late.ts', 'g\nx\n', 'g\ny\n');
  playAll();
  const typed = push('big.ts', big2, big2 + 'typed');
  t.begin(typed.seq);
  // Its mirror is typed into a character at a time between passes, and not shown, so nothing else diffs it.
  let typedChars = 0;
  const player = {
    liveText: (relPath: string) => (relPath === 'big.ts' ? big2 + 'x'.repeat(typedChars++) : undefined),
    liveToken: (relPath: string) => (relPath === 'big.ts' ? 1 : undefined),
    onDidEditMirror: new vscode.EventEmitter<string>().event,
  } as unknown as Player;
  const view = new HighlightView(t, player, () => ({ highlightAdditions: false, markDeletions: true }), vscode.Uri.file('/ext'));
  try {
    const deadline = Date.now() + 5000;
    while (!view.highlightedPaths.includes('/late.ts') && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
    assert.deepEqual(view.highlightedPaths, ['/big.ts', '/late.ts']);
  } finally {
    view.dispose();
  }
});
