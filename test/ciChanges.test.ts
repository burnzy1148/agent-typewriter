import { test } from 'node:test';
import assert from 'node:assert/strict';
import { needsExtensionChecks } from '../scripts/ci-changes.mjs';

test('site-only changes skip the extension checks', () => {
  assert.equal(needsExtensionChecks(['site/src/content/docs/docs/limits.md', 'site/package.json']), false);
});

test('the site workflow counts as a site change', () => {
  assert.equal(needsExtensionChecks(['.github/workflows/site.yml', 'site/astro.config.mjs']), false);
});

test('a site change mixed with source runs everything', () => {
  assert.equal(needsExtensionChecks(['site/src/content/docs/docs/settings.mdx', 'src/config.ts']), true);
});

test('shared images run everything', () => {
  assert.equal(needsExtensionChecks(['images/demo.gif']), true);
});

test('package.json alone runs everything', () => {
  assert.equal(needsExtensionChecks(['package.json']), true);
});

test('no changed paths runs everything', () => {
  assert.equal(needsExtensionChecks([]), true);
  assert.equal(needsExtensionChecks(['', '  ']), true);
});

test('a rename out of site/ runs everything', () => {
  assert.equal(needsExtensionChecks(['site/notes.md', 'docs/notes.md']), true);
});

test('a rename into site/ runs everything', () => {
  assert.equal(needsExtensionChecks(['src/old.ts', 'site/old.ts']), true);
});

test('a path that only starts like site/ is not the site', () => {
  assert.equal(needsExtensionChecks(['site-notes.md']), true);
  assert.equal(needsExtensionChecks(['src/site/a.ts']), true);
});

test('other workflows run everything', () => {
  assert.equal(needsExtensionChecks(['.github/workflows/ci.yml']), true);
});
