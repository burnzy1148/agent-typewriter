import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AutoFollow } from '../src/autoFollow';
import { autoFollowDecision, AUTO_FOLLOW_IDLE_MS } from '../src/lanes';
import { Timeline, type NewChangeEvent } from '../src/timeline';

function ev(relPath: string, lane: string): NewChangeEvent {
  return { uri: 'file:///w/' + relPath, relPath, time: 1, kind: 'modify', before: 'a', after: 'b', eol: '\n', linesAdded: 1, linesRemoved: 1, lane };
}

const lanes = [
  { id: 'main', recording: true, lastActivity: 0 },
  { id: 'feat', recording: true, lastActivity: 0, firstPendingSeq: 4 },
];

test('auto-follow waits out the quiet period, then follows; never while typing or off', () => {
  const base = { enabled: true, playing: false, followed: 'main', lanes, quietSince: 1000 };
  assert.deepEqual(autoFollowDecision({ ...base, now: 1500 }), { checkIn: AUTO_FOLLOW_IDLE_MS - 500 });
  assert.deepEqual(autoFollowDecision({ ...base, now: 1000 + AUTO_FOLLOW_IDLE_MS }), { follow: 'feat' });
  assert.deepEqual(autoFollowDecision({ ...base, playing: true, now: 99_999 }), {});
  assert.deepEqual(autoFollowDecision({ ...base, enabled: false, now: 99_999 }), {});
  assert.deepEqual(autoFollowDecision({ ...base, followed: 'feat', now: 99_999 }), {}, 'the followed lane has changes queued');
});

test('the controller tours a lane with queued changes once the followed lane is quiet', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const tl = new Timeline(100);
  tl.defineLane({ id: 'main', label: 'main', root: '/w', color: 1, recording: true });
  tl.defineLane({ id: 'feat', label: 'feat', root: '/f', color: 2, recording: true });
  let on = false;
  const auto = new AutoFollow(tl, () => on);
  tl.push(ev('feat/a.ts', 'feat'));
  assert.equal(tl.followed, 'main');
  on = true;
  auto.check();
  t.mock.timers.tick(AUTO_FOLLOW_IDLE_MS - 1);
  assert.equal(tl.followed, 'main');
  t.mock.timers.tick(1);
  assert.equal(tl.followed, 'feat');
  auto.dispose();
});

test('a busy followed lane stays followed', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const tl = new Timeline(100);
  tl.defineLane({ id: 'main', label: 'main', root: '/w', color: 1, recording: true });
  tl.defineLane({ id: 'feat', label: 'feat', root: '/f', color: 2, recording: true });
  const auto = new AutoFollow(tl, () => true);
  tl.push(ev('feat/a.ts', 'feat'));
  for (let i = 0; i < 5; i++) {
    t.mock.timers.tick(AUTO_FOLLOW_IDLE_MS - 1000);
    const e = tl.push(ev(`a${i}.ts`, 'main'));
    tl.begin(e.seq);
    t.mock.timers.tick(500);
    tl.complete(e.seq);
  }
  assert.equal(tl.followed, 'main');
  auto.dispose();
});

test('the quiet period starts when a long change finishes typing, not when it began', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const tl = new Timeline(100);
  tl.defineLane({ id: 'main', label: 'main', root: '/w', color: 1, recording: true });
  tl.defineLane({ id: 'feat', label: 'feat', root: '/f', color: 2, recording: true });
  const auto = new AutoFollow(tl, () => true);
  const e = tl.push(ev('a.ts', 'main'));
  tl.push(ev('feat/a.ts', 'feat'));
  tl.begin(e.seq);
  t.mock.timers.tick(AUTO_FOLLOW_IDLE_MS + 500);
  tl.complete(e.seq);
  assert.equal(tl.followed, 'main', 'switched the moment typing ended');
  t.mock.timers.tick(AUTO_FOLLOW_IDLE_MS - 1);
  assert.equal(tl.followed, 'main');
  t.mock.timers.tick(1);
  assert.equal(tl.followed, 'feat');
  auto.dispose();
});

test('a lane followed by hand gets its own quiet period before auto-follow moves on', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const tl = new Timeline(100);
  tl.defineLane({ id: 'a', label: 'a', root: '/a', color: 1, recording: true });
  tl.defineLane({ id: 'c', label: 'c', root: '/c', color: 2, recording: true });
  const on = new AutoFollow(tl, () => true);
  // Lane a is followed with a change queued, and playback is paused for a minute.
  tl.push(ev('a.ts', 'a'));
  t.mock.timers.tick(60_000);
  tl.follow('c');
  assert.equal(tl.followed, 'c', 'the follow by hand was undone at once');
  t.mock.timers.tick(AUTO_FOLLOW_IDLE_MS - 1);
  assert.equal(tl.followed, 'c');
  t.mock.timers.tick(1);
  assert.equal(tl.followed, 'a', 'after its quiet period, auto-follow moves on as usual');
  on.dispose();
});
