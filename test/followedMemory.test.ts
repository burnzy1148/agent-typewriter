import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FollowedMemory } from '../src/followedMemory';
import { Timeline, type NewChangeEvent } from '../src/timeline';

function ev(relPath: string, lane: string): NewChangeEvent {
  return { uri: 'file:///w/' + relPath, relPath, time: 1, kind: 'modify', before: 'a', after: 'b', eol: '\n', linesAdded: 1, linesRemoved: 1, lane };
}

test('a lane followed by hand is remembered; the one a replaced buffer falls back to is not', () => {
  const t = new Timeline(100);
  t.defineLane({ id: 'main', label: 'main', root: '/w', color: 1, recording: true });
  t.defineLane({ id: 'w', label: 'w', root: '/w2', color: 2, recording: true });
  t.push(ev('a.ts', 'main'));
  t.push(ev('w/a.ts', 'w'));
  const saved: string[] = [];
  let changes = 0;
  const memory = new FollowedMemory(t, (lane) => saved.push(lane), () => changes++);
  t.follow('w');
  assert.deepEqual(saved, ['w']);
  // A git replay or loaded session follows its own lane: not the user's choice.
  const replay = { id: 'git-replay:main..x', label: 'main..x', root: '', color: 1 };
  memory.quietly(() => t.restore([{ ...ev('r.ts', replay.id), seq: 1 }], 1, undefined, { lanes: [replay], followed: replay.id }));
  assert.equal(t.followed, replay.id);
  assert.deepEqual(saved, ['w'], 'the replay lane was remembered');
  assert.equal(changes, 2, 'the status still hears about every change of lane');
  memory.dispose();
});
