import { test } from 'node:test';
import assert from 'node:assert/strict';
import { statusPresentation, type StatusInput } from '../src/statusText';

const base: StatusInput = {
  watching: true,
  paused: false,
  pending: 0,
  speed: 1,
  watchedCount: 12,
  filter: 'all files',
  profile: '',
  checkouts: [],
};
const ownCheckout = [{ own: true, name: 'main', worktrees: 2 }];
const feature = [{ own: false, name: 'feature', worktrees: 2 }];
const states: Array<[string, Partial<StatusInput>]> = [
  ['watching, paused', { watching: true, paused: true, pending: 2 }],
  ['watching, playing', { watching: true, paused: false, pending: 2 }],
  ['not watching, draining', { watching: false, paused: false, pending: 2 }],
  ['not watching, paused with queue', { watching: false, paused: true, pending: 2 }],
  ['not watching, nothing queued', { watching: false, paused: false, pending: 0 }],
];

test('statusPresentation: an active profile is named in every tooltip and leads the description', () => {
  for (const [label, state] of states) {
    for (const checkouts of [ownCheckout, feature]) {
      const s = statusPresentation({ ...base, ...state, checkouts, profile: 'docs', filter: 'docs: .md in docs/**' });
      assert.match(s.tooltip, /docs/, `${label}: ${s.tooltip}`);
      if (state.watching) {
        assert.ok(s.description.startsWith('docs'), `${label}: ${s.description}`);
        if (checkouts === feature) assert.match(s.description, /feature/, `${label}: the chosen checkout is not shown`);
      } else {
        assert.match(s.description, /docs/, `${label}: ${s.description}`);
      }
    }
  }
});

test('statusPresentation: paused while recording says what is watched and how to resume', () => {
  const s = statusPresentation({ ...base, paused: true, pending: 3, profile: 'docs', filter: 'docs: .md in docs/**', checkouts: feature });
  assert.equal(s.tooltip, 'Watching 12 files in checkout feature (docs: .md in docs/**). Click to resume playback.');
  assert.equal(s.text, '$(debug-pause) Typewriter paused · 3 queued');
  assert.equal(s.command, 'agentTypewriter.togglePause');
});

test('statusPresentation: without a profile the texts are unchanged except where the checkout sits', () => {
  assert.deepEqual(statusPresentation({ ...base, watching: false }), {
    text: '$(keyboard) Typewriter',
    tooltip: 'Agent Typewriter is not watching. Click to start.',
    command: 'agentTypewriter.start',
    description: 'stopped',
    checkout: undefined,
  });
  const playing = statusPresentation({ ...base, pending: 1, speed: 2, checkouts: feature, filter: '.ts' });
  assert.equal(playing.text, '$(record) Typewriter · 1 queued 2x');
  assert.equal(playing.tooltip, 'Watching 12 files in checkout feature (.ts). Click to pause.');
  assert.equal(playing.description, '.ts · checkout feature');
  assert.deepEqual(playing.checkout, {
    text: '$(git-branch) feature',
    tooltip: 'Agent Typewriter records checkout feature. Click to choose another.',
  });
  const draining = statusPresentation({ ...base, watching: false, pending: 1 });
  assert.equal(draining.tooltip, 'Not watching; draining the buffer. Click to pause.');
  assert.equal(statusPresentation({ ...base, paused: true }).tooltip, 'Watching 12 files (all files). Click to resume playback.');
});

test('statusPresentation: the checkout entry shows only when a folder has more than one worktree', () => {
  assert.equal(statusPresentation({ ...base, checkouts: [{ own: true, name: 'main', worktrees: 1 }] }).checkout, undefined);
  assert.equal(statusPresentation({ ...base, checkouts: ownCheckout }).checkout?.text, '$(git-branch) main');
  assert.equal(
    statusPresentation({ ...base, watching: false, checkouts: ownCheckout }).checkout?.tooltip,
    'Agent Typewriter will record checkout main. Click to choose another.',
  );
});
