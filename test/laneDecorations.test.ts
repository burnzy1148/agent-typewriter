import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mirrorLane } from '../src/laneDecorations';
import { Timeline, type NewChangeEvent } from '../src/timeline';

function ev(relPath: string, lane: string, fromRelPath?: string): NewChangeEvent {
  return {
    uri: 'file:///w/' + relPath,
    relPath,
    time: 1,
    kind: fromRelPath ? 'rename' : 'modify',
    before: 'a',
    after: 'b',
    eol: '\n',
    linesAdded: 1,
    linesRemoved: 1,
    lane,
    ...(fromRelPath && { fromUri: 'file:///w/' + fromRelPath, fromRelPath }),
  };
}

test('a mirror belongs to the lane of the newest change at its path', () => {
  const t = new Timeline(100);
  t.defineLane({ id: 'main', label: 'main', root: '/w', color: 1, recording: true });
  t.defineLane({ id: 'feat', label: 'feature', root: '/f', color: 2, recording: true });
  t.push(ev('a.ts', 'main'));
  t.push(ev('feat/a.ts', 'feat'));
  t.push(ev('feat/b.ts', 'feat', 'feat/old.ts'));
  assert.equal(mirrorLane(t, 'a.ts')?.id, 'main');
  assert.equal(mirrorLane(t, 'feat/a.ts')?.color, 2);
  assert.equal(mirrorLane(t, 'feat/old.ts')?.id, 'feat', 'a renamed-away path keeps its lane');
  assert.equal(mirrorLane(t, 'nowhere.ts'), undefined);
});
