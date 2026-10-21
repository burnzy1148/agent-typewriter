import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { REPO_SETTING_KINDS, changedKeys, parseRepoSettings, pickLayer } from '../src/repoSettings';

const root = path.join(__dirname, '..');
const readJson = (rel: string) => JSON.parse(fs.readFileSync(path.join(root, rel), 'utf8'));

function parsed(text: string) {
  const r = parseRepoSettings(text);
  assert.ok(r.ok, 'expected the file to parse');
  return r;
}

test('valid values pass through', () => {
  const r = parsed(
    JSON.stringify({
      include: ['src/**'],
      extensions: [],
      charsPerSecond: 50,
      autoStart: true,
      languageSpeeds: { markdown: 60 },
      reorderWindowMs: 'auto',
      viewColumn: 'active',
    }),
  );
  assert.deepEqual(r.problems, []);
  assert.deepEqual(r.values, {
    include: ['src/**'],
    extensions: [],
    charsPerSecond: 50,
    autoStart: true,
    languageSpeeds: { markdown: 60 },
    reorderWindowMs: 'auto',
    viewColumn: 'active',
  });
  assert.deepEqual(parsed('{"reorderWindowMs": 1000}').values, { reorderWindowMs: 1000 });
});

test('$schema is allowed and ignored', () => {
  const r = parsed('{"$schema": "./schema.json", "jitter": 0}');
  assert.deepEqual(r.values, { jitter: 0 });
  assert.deepEqual(r.problems, []);
});

test('unknown keys are dropped and reported', () => {
  const r = parsed('{"agentTypewriter.include": ["x"], "speed": 3, "debounceMs": 10}');
  assert.deepEqual(r.values, { debounceMs: 10 });
  assert.equal(r.problems.length, 2);
  assert.match(r.problems[0], /agentTypewriter\.include/);
  assert.match(r.problems[1], /speed/);
});

test('wrong types are dropped and reported, the rest kept', () => {
  const r = parsed(
    JSON.stringify({
      extensions: 'ts',
      include: ['ok', 3],
      charsPerSecond: 50,
      jitter: '0.5',
      autoStart: 'yes',
      viewColumn: 'left',
      languageSpeeds: [60],
      reorderWindowMs: true,
    }),
  );
  assert.deepEqual(r.values, { charsPerSecond: 50 });
  assert.deepEqual(
    r.problems.map((p) => p.match(/^"(\w+)"/)?.[1]),
    ['extensions', 'include', 'jitter', 'autoStart', 'viewColumn', 'languageSpeeds', 'reorderWindowMs'],
  );
  assert.match(r.problems[0], /array of strings/);
  assert.match(r.problems[4], /"beside", "active"/);
});

test('non-finite numbers are not numbers', () => {
  // JSON cannot express NaN, but 1e999 parses to Infinity.
  assert.deepEqual(parsed('{"charsPerSecond": 1e999}').values, {});
});

test('a non-object root or invalid JSON fails', () => {
  for (const text of ['[]', '"x"', '3', 'null', '{"include": [', '{include: []}']) {
    const r = parseRepoSettings(text);
    assert.equal(r.ok, false, `expected ${text} to fail`);
  }
});

test('an empty file is an empty object', () => {
  assert.deepEqual(parsed('  \n').values, {});
});

test('pickLayer: workspace, then file, then below', () => {
  const below = () => 'user-or-default';
  assert.equal(pickLayer('ws', 'file', below), 'ws');
  assert.equal(pickLayer(undefined, 'file', below), 'file');
  assert.equal(pickLayer(undefined, undefined, below), 'user-or-default');
  assert.deepEqual(pickLayer<string[]>([], ['file'], () => ['x']), [], 'an empty workspace array still wins');
});

test('changedKeys compares by value', () => {
  assert.deepEqual(changedKeys({}, {}), []);
  assert.deepEqual(changedKeys({ include: ['a'] }, { include: ['a'] }), []);
  assert.deepEqual(changedKeys({ include: ['a'], jitter: 0 }, { include: ['b'], debounceMs: 5, jitter: 0 }).sort(), [
    'debounceMs',
    'include',
  ]);
});

test('file format, schema, and package.json settings list the same keys', () => {
  const pkg = readJson('package.json');
  const schema = readJson('schemas/agent-typewriter.schema.json');
  const settings = pkg.contributes.configuration.properties as Record<string, { type: unknown }>;
  const fromPkg = Object.keys(settings).map((k) => k.replace(/^agentTypewriter\./, '')).sort();
  assert.deepEqual(Object.keys(REPO_SETTING_KINDS).sort(), fromPkg, 'REPO_SETTING_KINDS is out of date');
  const schemaKeys = Object.keys(schema.properties).filter((k) => k !== '$schema').sort();
  assert.deepEqual(schemaKeys, fromPkg, 'schemas/agent-typewriter.schema.json is out of date');
  for (const k of fromPkg) {
    assert.deepEqual(schema.properties[k].type, settings[`agentTypewriter.${k}`].type, `schema type of ${k}`);
  }
  assert.equal(schema.additionalProperties, false);
  const validation = pkg.contributes.jsonValidation as { fileMatch: string; url: string }[];
  assert.ok(validation.some((v) => v.url === './schemas/agent-typewriter.schema.json'), 'jsonValidation missing');
  assert.match(fs.readFileSync(path.join(root, '.vscodeignore'), 'utf8'), /^!schemas\/agent-typewriter\.schema\.json$/m);
});
