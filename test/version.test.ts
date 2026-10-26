import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  newestPrereleaseTag, nextPrerelease, nextStable, prereleaseMinor, prereleaseNotesStart,
  previousStableTag, publishCheck, streamTag, toPrune,
} from '../scripts/version.mjs';

const pre = (...versions: string[]) => versions.map((version) => ({ version, preRelease: true }));
const stable = (...versions: string[]) => versions.map((version) => ({ version, preRelease: false }));

test('minor bump from an odd stable minor skips past the pre-release stream', () => {
  assert.equal(nextStable('0.3.0', 'minor'), '0.6.0');
});

test('minor bump from an even stable minor', () => {
  assert.equal(nextStable('0.6.2', 'minor'), '0.8.0');
});

test('patch and major bumps', () => {
  assert.equal(nextStable('0.6.0', 'patch'), '0.6.1');
  assert.equal(nextStable('0.6.0', 'major'), '1.0.0');
  assert.throws(() => nextStable('0.6.0', 'huge' as never));
});

test('pre-release minor is the first odd minor above the stable one', () => {
  assert.equal(prereleaseMinor('0.3.0'), 5);
  assert.equal(prereleaseMinor('0.4.0'), 5);
  assert.equal(prereleaseMinor('0.6.1'), 7);
  assert.equal(prereleaseMinor('1.0.0'), 1);
});

test('first pre-release after 0.3.0', () => {
  assert.equal(nextPrerelease('0.3.0', ['v0.3.0', 'v0.2.0']), '0.5.0');
});

test('next pre-release counts the stream\'s tags', () => {
  assert.equal(nextPrerelease('0.3.0', ['pre-v0.5.0', 'pre-v0.5.1']), '0.5.2');
});

test('after a minor stable release a new stream starts', () => {
  assert.equal(nextPrerelease('0.6.0', ['pre-v0.5.0', 'pre-v0.5.7', 'v0.6.0']), '0.7.0');
});

test('after a patch stable release the stream continues', () => {
  assert.equal(nextPrerelease('0.6.1', ['pre-v0.7.3', 'v0.6.0', 'v0.6.1']), '0.7.4');
});

test('counting ignores stable, malformed and other-stream tags', () => {
  const tags = ['v0.5.9', 'pre-v0.5', 'pre-v0.5.x', 'xpre-v0.5.8', 'pre-v0.5.2-beta', 'pre-v1.5.4', 'pre-v0.5.1', ''];
  assert.equal(nextPrerelease('0.3.0', tags), '0.5.2');
});

test('versions compare numerically', () => {
  assert.equal(nextPrerelease('0.3.0', ['pre-v0.5.9', 'pre-v0.5.10']), '0.5.11');
  assert.equal(newestPrereleaseTag(['pre-v0.5.9', 'pre-v0.5.10', 'v0.6.0']), 'pre-v0.5.10');
});

test('stream tag is the newest tag of the current stream only', () => {
  assert.equal(streamTag('0.3.0', ['pre-v0.5.1', 'pre-v0.5.3', 'pre-v0.7.0']), 'pre-v0.5.3');
  assert.equal(streamTag('0.6.0', ['pre-v0.5.3']), undefined);
});

test('newest pre-release tag across streams', () => {
  assert.equal(newestPrereleaseTag(['pre-v0.5.3', 'pre-v0.7.0', 'v0.6.0']), 'pre-v0.7.0');
  assert.equal(newestPrereleaseTag(['v0.3.0']), undefined);
});

test('previous stable tag ignores pre-release tags', () => {
  const tags = ['v0.2.0', 'v0.3.0', 'pre-v0.5.0', 'pre-v0.5.4', 'v0.6.0'];
  assert.equal(previousStableTag('0.6.0', tags), 'v0.3.0');
  assert.equal(previousStableTag('0.3.0', tags), 'v0.2.0');
  assert.equal(previousStableTag('0.2.0', tags), undefined);
});

test('pre-release notes start at the previous published pre-release, else the stable tag', () => {
  const tags = ['v0.3.0', 'pre-v0.5.0', 'pre-v0.5.3', 'pre-v0.5.4'];
  assert.equal(prereleaseNotesStart('0.5.4', ['pre-v0.5.0', 'pre-v0.5.3', 'pre-v0.5.4'], tags), 'pre-v0.5.3');
  assert.equal(prereleaseNotesStart('0.5.0', [], tags), 'v0.3.0');
});

test('publish a version above everything on the Marketplace', () => {
  assert.deepEqual(publishCheck('0.5.4', [...stable('0.3.0', '0.2.0'), ...pre('0.5.3')]), { action: 'publish' });
  assert.deepEqual(publishCheck('0.5.0', []), { action: 'publish' });
});

test('refuse a version older than the Marketplace', () => {
  const check = publishCheck('0.5.3', [...stable('0.3.0'), ...pre('0.5.4')]);
  assert.equal(check.action, 'refuse');
  assert.match('reason' in check ? check.reason : '', /0\.5\.4/);
});

test('refuse a build a stable release overtook', () => {
  assert.equal(publishCheck('0.5.6', [...stable('0.6.0', '0.3.0'), ...pre('0.5.4')]).action, 'refuse');
});

test('finish a pre-release already published', () => {
  assert.deepEqual(publishCheck('0.5.4', [...stable('0.3.0'), ...pre('0.5.4', '0.5.3')]), { action: 'finish' });
});

test('refuse a version already published as stable', () => {
  assert.equal(publishCheck('0.3.0', stable('0.3.0')).action, 'refuse');
});

test('refuse a malformed version', () => {
  assert.throws(() => publishCheck('0.5', []));
});

test('third pre-release prunes the oldest', () => {
  assert.deepEqual(toPrune([...pre('0.5.0', '0.5.3', '0.5.4'), ...stable('0.3.0', '0.2.0')], 2), ['0.5.0']);
});

test('pruning never selects stable versions', () => {
  assert.deepEqual(toPrune(stable('0.3.0', '0.2.0'), 0), []);
  assert.deepEqual(toPrune([...stable('0.6.0', '0.3.0'), ...pre('0.5.4')], 0), ['0.5.4']);
});

test('fewer pre-releases than keep prunes nothing', () => {
  assert.deepEqual(toPrune(pre('0.5.0'), 2), []);
});

test('pruning orders numerically', () => {
  assert.deepEqual(toPrune(pre('0.5.9', '0.5.10', '0.5.11'), 2), ['0.5.9']);
});
