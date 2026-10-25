import { test } from 'node:test';
import assert from 'node:assert/strict';
import { autoFollowTarget, colorSlot, defaultLanes, laneBadge, laneLabel, rotationVictim, ROTATE_IDLE_MS, type LaneActivity } from '../src/lanes';

test('a lane keeps its remembered color while it is free', () => {
  assert.equal(colorSlot(3, [1, 2]), 3);
});

test('a taken remembered color falls back to the lowest free one', () => {
  assert.equal(colorSlot(2, [1, 2]), 3);
  assert.equal(colorSlot(undefined, []), 1);
  assert.equal(colorSlot(9, [1]), 2);
});

test('colors repeat past five, least used first', () => {
  assert.equal(colorSlot(undefined, [1, 2, 3, 4, 5]), 1);
  assert.equal(colorSlot(undefined, [1, 2, 3, 4, 5, 1]), 2);
});

const now = 10_000_000;
const lane = (id: string, idleMs: number, extra: Partial<LaneActivity> = {}): LaneActivity => ({ id, recording: true, lastActivity: now - idleMs, ...extra });

test('rotation stops the lane idle longest', () => {
  const lanes = [lane('a', ROTATE_IDLE_MS + 1000), lane('b', ROTATE_IDLE_MS * 10), lane('c', 1000)];
  assert.equal(rotationVictim(lanes, undefined, now), 'b');
});

test('rotation never stops the followed lane, a stopped lane, or a recently active one', () => {
  const lanes = [lane('a', ROTATE_IDLE_MS * 10), lane('b', ROTATE_IDLE_MS * 20, { recording: false }), lane('c', ROTATE_IDLE_MS - 1)];
  assert.equal(rotationVictim(lanes, 'a', now), undefined);
});

test('rotation finds no lane when all are busy', () => {
  assert.equal(rotationVictim([lane('a', 0), lane('b', 5000)], undefined, now), undefined);
});

test('auto-follow picks the lane whose oldest pending change came first', () => {
  const lanes = [lane('a', 0, { firstPendingSeq: 4 }), lane('b', 0, { firstPendingSeq: 9 }), lane('c', 0, { firstPendingSeq: 2 }), lane('d', 0)];
  assert.equal(autoFollowTarget(lanes, 'c'), 'a');
  assert.equal(autoFollowTarget(lanes, 'a'), 'c');
  assert.equal(autoFollowTarget([lane('a', 0), lane('d', 0)], 'a'), undefined);
});

test('labels name the branch, the folder outside git, and the folder in multi-root', () => {
  assert.equal(laneLabel('feature', 'repo', false), 'feature');
  assert.equal(laneLabel('feature', 'repo', true), 'feature (repo)');
  assert.equal(laneLabel('', 'notes', true), 'notes');
});

test('badges are initials or the first two letters', () => {
  assert.equal(laneBadge('feature/combat'), 'FC');
  assert.equal(laneBadge('main'), 'MA');
  assert.equal(laneBadge('a1b2c3d'), 'A1');
  assert.equal(laneBadge('--'), '?');
  assert.equal(laneBadge('ßa'), 'SS', 'never longer than two characters');
  assert.equal(laneBadge('straße fix'), 'SF');
});

test('the first five folders record by default, the rest are named', () => {
  const r = defaultLanes(['a', 'b', 'c', 'd', 'e', 'f', 'g']);
  assert.deepEqual(r.recorded, ['a', 'b', 'c', 'd', 'e']);
  assert.deepEqual(r.left, ['f', 'g']);
});
