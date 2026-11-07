import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { PLAYBACK_NUMBERS, PLAYBACK_SWITCHES, recordGetter, resolvePlaybackSettings } from '../src/playbackSettings';
import { readSettings, setRepoValues } from '../src/config';
import * as core from '../claude-code/hooks/core.mjs';
import { mock } from './vscode-mock';

const DEFAULTS = {
  jitter: 0.6,
  catchUpFactor: 0.5,
  maxSpeedup: 8,
  maxAnimatedChars: 6000,
  fileSwitchDelayMs: 1000,
  scrollLinesPerSecond: 60,
  arrowKeysPerSecond: 15,
  smoothScroll: true,
  arrowNavigation: true,
  naturalOrder: true,
  languageSpeeds: {},
};

const resolve = (values: Record<string, unknown>) => resolvePlaybackSettings(recordGetter(values));

test('nothing set gives every default', () => {
  assert.deepEqual(resolve({}), DEFAULTS);
});

test('values in range are used as is', () => {
  const values = {
    jitter: 0.2,
    catchUpFactor: 2,
    maxSpeedup: 3,
    maxAnimatedChars: 100,
    fileSwitchDelayMs: 0,
    scrollLinesPerSecond: 5,
    arrowKeysPerSecond: 40,
    smoothScroll: false,
    arrowNavigation: false,
    naturalOrder: false,
    languageSpeeds: { python: 600 },
  };
  assert.deepEqual(resolve(values), values);
});

test('numbers are clamped to their limits', () => {
  const low = resolve({
    jitter: -1,
    catchUpFactor: -1,
    maxSpeedup: 0.5,
    fileSwitchDelayMs: -5,
    scrollLinesPerSecond: 0,
    arrowKeysPerSecond: 0,
    maxAnimatedChars: -10,
  });
  assert.equal(low.jitter, 0);
  assert.equal(low.catchUpFactor, 0);
  assert.equal(low.maxSpeedup, 1);
  assert.equal(low.fileSwitchDelayMs, 0);
  assert.equal(low.scrollLinesPerSecond, 1);
  assert.equal(low.arrowKeysPerSecond, 1);
  assert.equal(low.maxAnimatedChars, -10, 'maxAnimatedChars has no limit');
  const high = resolve({ jitter: 3, fileSwitchDelayMs: 60000, catchUpFactor: 1e9, maxSpeedup: 1e9 });
  assert.equal(high.jitter, 1);
  assert.equal(high.fileSwitchDelayMs, 15000);
  assert.equal(high.catchUpFactor, 1e9, 'catchUpFactor has no upper limit');
  assert.equal(high.maxSpeedup, 1e9, 'maxSpeedup has no upper limit');
});

test('a number that is not finite counts as unset', () => {
  for (const bad of ['0.2', null, NaN, Infinity, -Infinity, {}, [1]]) {
    assert.equal(resolve({ jitter: bad }).jitter, 0.6, String(bad));
  }
});

test('an on/off setting that is not a boolean counts as unset', () => {
  for (const bad of ['false', 0, 1, null, {}]) {
    const r = resolve({ smoothScroll: bad, arrowNavigation: bad, naturalOrder: bad });
    assert.deepEqual([r.smoothScroll, r.arrowNavigation, r.naturalOrder], [true, true, true], String(bad));
  }
});

test('languageSpeeds that is not an object reads as empty', () => {
  for (const bad of [null, [1], 'python', 3]) assert.deepEqual(resolve({ languageSpeeds: bad }).languageSpeeds, {}, String(bad));
});

test('recordGetter: undefined counts as unset, and so does a value its check rejects', () => {
  const get = recordGetter({ a: undefined, b: 'x', c: 2 });
  const isNumber = (v: unknown): v is number => typeof v === 'number';
  assert.equal(get('a', 1), 1);
  assert.equal(get('missing', 1), 1);
  assert.equal(get('b', 1, isNumber), 1);
  assert.equal(get('c', 1, isNumber), 2);
  assert.equal(get('toString', 1), 1, 'inherited properties are not values');
});

test('the defaults and limits match what package.json declares', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
  const props = pkg.contributes.configuration.properties ?? Object.assign({}, ...pkg.contributes.configuration.map((c: { properties: object }) => c.properties));
  for (const [key, spec] of Object.entries(PLAYBACK_NUMBERS) as [string, { default: number; min?: number; max?: number }][]) {
    const p = props[`agentTypewriter.${key}`];
    assert.equal(p.type, 'number', key);
    assert.deepEqual({ default: p.default, min: p.minimum, max: p.maximum }, { default: spec.default, min: spec.min, max: spec.max }, key);
  }
  for (const [key, fallback] of Object.entries(PLAYBACK_SWITCHES)) {
    assert.deepEqual({ type: props[`agentTypewriter.${key}`].type, default: props[`agentTypewriter.${key}`].default }, { type: 'boolean', default: fallback }, key);
  }
});

test('readSettings resolves playback through the layers, a wrong-typed value falling through to the next', () => {
  mock.reset();
  setRepoValues({});
  try {
    assert.deepEqual(pick(readSettings()), DEFAULTS);
    setRepoValues({ jitter: 0.3, maxSpeedup: 0 });
    assert.equal(readSettings().jitter, 0.3);
    assert.equal(readSettings().maxSpeedup, 1, 'clamped');
    mock.set('agentTypewriter.jitter', 0.9);
    assert.equal(readSettings().jitter, 0.9, 'a workspace setting wins over the file');
    mock.set('agentTypewriter.jitter', 'high');
    assert.equal(readSettings().jitter, 0.3, 'a wrong-typed workspace setting falls through to the file');
    mock.set('agentTypewriter.smoothScroll', false);
    assert.equal(readSettings().smoothScroll, false);
    setRepoValues({ smoothScroll: false });
    mock.set('agentTypewriter.smoothScroll', 'true');
    assert.equal(readSettings().smoothScroll, false, 'a wrong-typed workspace switch falls through to the file');
    setRepoValues({});
    assert.equal(readSettings().smoothScroll, true, 'and with nothing below it, to the default');
  } finally {
    setRepoValues({});
    mock.reset();
  }
});

test('the Claude Code plugin core exports the resolver', () => {
  assert.deepEqual(core.resolvePlaybackSettings(core.recordGetter({ jitter: 5 })), { ...DEFAULTS, jitter: 1 });
  assert.deepEqual(core.PLAYBACK_NUMBERS, PLAYBACK_NUMBERS);
  assert.equal(core.resolveCharsPerMinute([{}]).charsPerMinute, core.DEFAULT_CHARS_PER_MINUTE);
  assert.equal(core.resolveReadPauseSeconds([{}]).readPauseSeconds, core.DEFAULT_READ_PAUSE_SECONDS);
});

function pick(s: object) {
  return Object.fromEntries(Object.keys(DEFAULTS).map((k) => [k, (s as Record<string, unknown>)[k]]));
}
