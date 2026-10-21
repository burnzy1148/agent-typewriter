import { test } from 'node:test';
import assert from 'node:assert/strict';
import { activeProfileOf, describeProfile, isValidProfileName, mergeProfiles, parseProfiles } from '../src/profiles';
import { parseRepoSettings } from '../src/repoSettings';

test('parseProfiles: valid profiles pass through', () => {
  const r = parseProfiles({ docs: { include: ['docs/**'], extensions: ['md'] }, all: {}, git: { respectGitignore: true } });
  assert.deepEqual(r.problems, []);
  assert.deepEqual(r.profiles, { docs: { include: ['docs/**'], extensions: ['md'] }, all: {}, git: { respectGitignore: true } });
});

test('parseProfiles: an invalid entry is dropped, the rest of the profile kept', () => {
  const r = parseProfiles({ docs: { extensions: 'md', include: ['docs/**'], respectGitignore: 'yes', speed: 3 } });
  assert.deepEqual(r.profiles, { docs: { include: ['docs/**'] } });
  assert.equal(r.problems.length, 3);
  assert.match(r.problems[0], /"docs": "extensions" should be an array of strings/);
  assert.match(r.problems[1], /"respectGitignore" should be true or false/);
  assert.match(r.problems[2], /"speed" is not a filter setting/);
});

test('parseProfiles: non-object profiles and roots', () => {
  const r = parseProfiles({ a: ['x'], b: null, c: { exclude: [] } });
  assert.deepEqual(r.profiles, { c: { exclude: [] } });
  assert.equal(r.problems.length, 2);
  assert.equal(parseProfiles([]).problems.length, 1);
  assert.deepEqual(parseProfiles(undefined), { profiles: {}, problems: [] });
});

test('mergeProfiles: higher layers replace same-named profiles whole', () => {
  const user = { docs: { include: ['old/**'], extensions: ['md'] }, mine: { include: ['x/**'] } };
  const file = { docs: { include: ['docs/**'] }, backend: { include: ['server/**'] } };
  const workspace = { docs: { include: ['site/**'] } };
  assert.deepEqual(mergeProfiles(user, file, workspace), {
    docs: { include: ['site/**'] },
    mine: { include: ['x/**'] },
    backend: { include: ['server/**'] },
  });
  assert.deepEqual(mergeProfiles(undefined, file), file);
});

test('activeProfileOf: none, known, unknown', () => {
  const profiles = { docs: { include: ['docs/**'] } };
  assert.equal(activeProfileOf({ activeProfile: '', profiles }), undefined);
  assert.deepEqual(activeProfileOf({ activeProfile: 'docs', profiles }), { include: ['docs/**'] });
  assert.equal(activeProfileOf({ activeProfile: 'nope', profiles }), undefined);
  assert.equal(activeProfileOf({ activeProfile: 'toString', profiles }), undefined, 'prototype names are not profiles');
});

test('describeProfile summarizes set keys', () => {
  assert.equal(describeProfile({ include: ['docs/**'], extensions: ['md', 'mdx'] }), 'include: docs/** · extensions: md, mdx');
  assert.equal(describeProfile({ exclude: [], respectGitignore: true }), 'exclude: (none) · respectGitignore: true');
  assert.equal(describeProfile({}), 'no filters set');
});

test('repository file: profiles are validated entry by entry, activeProfile is a string', () => {
  const r = parseRepoSettings(JSON.stringify({ profiles: { docs: { include: ['docs/**'], extensions: 'md' } }, activeProfile: 'docs' }));
  assert.ok(r.ok);
  assert.deepEqual(r.values, { profiles: { docs: { include: ['docs/**'] } }, activeProfile: 'docs' });
  assert.equal(r.problems.length, 1);
  const bad = parseRepoSettings(JSON.stringify({ profiles: ['docs'], activeProfile: 3 }));
  assert.ok(bad.ok);
  assert.deepEqual(bad.values, {});
  assert.equal(bad.problems.length, 2);
});

test('parseProfiles: __proto__ and blank names are rejected and reported', () => {
  const r = parseProfiles(JSON.parse('{"__proto__": {"include": ["x/**"]}, " ": {}, "ok": {}}'));
  assert.deepEqual(Object.keys(r.profiles), ['ok']);
  assert.equal(Object.getPrototypeOf(r.profiles), Object.prototype);
  assert.equal(r.problems.length, 2);
  assert.match(r.problems[0], /"__proto__" cannot be used as a profile name/);
  assert.equal(isValidProfileName('docs'), true);
  assert.equal(isValidProfileName('__proto__'), false);
});
