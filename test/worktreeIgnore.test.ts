import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ignoringPattern, suggestIgnorePattern } from '../src/worktreeIgnore';

test('ignoringPattern: a slash-free pattern matches the directory name', () => {
  assert.equal(ignoringPattern(['review-*'], '/repo/.claude/worktrees/review-mr-203', undefined, 'darwin'), 'review-*');
  assert.equal(ignoringPattern(['review-*'], '/repo/.claude/worktrees/fix-hud', 'fix/hud', 'darwin'), undefined);
  // Only the last segment counts for a slash-free pattern.
  assert.equal(ignoringPattern(['review-*'], '/review-repos/main', 'main', 'darwin'), undefined);
});

test('ignoringPattern: a pattern with a slash matches the whole path', () => {
  assert.equal(ignoringPattern(['**/T/tmp.*'], '/private/var/folders/cl/x/T/tmp.L3Sq3tW6o2', undefined, 'darwin'), '**/T/tmp.*');
  assert.equal(ignoringPattern(['**/.claude/worktrees/**'], '/repo/.claude/worktrees/a', 'a', 'darwin'), '**/.claude/worktrees/**');
  assert.equal(ignoringPattern(['**/T/tmp.*'], '/repo/tmp.x', undefined, 'darwin'), undefined);
});

test('ignoringPattern: branch: patterns match the branch, never a detached worktree', () => {
  assert.equal(ignoringPattern(['branch:review/*'], '/repo/wt', 'review/42', 'darwin'), 'branch:review/*');
  assert.equal(ignoringPattern(['branch:review/*'], '/repo/wt', undefined, 'darwin'), undefined);
  assert.equal(ignoringPattern(['branch:review/*'], '/repo/review', 'main', 'darwin'), undefined, 'a branch pattern ignores the path');
  assert.equal(ignoringPattern(['branch:'], '/repo/wt', 'main', 'darwin'), undefined, 'an empty branch glob matches nothing');
});

test('ignoringPattern: the first matching pattern is named; blank entries are dropped', () => {
  assert.equal(ignoringPattern(['', '  ', 'nope', 'wt*', '*'], '/repo/wt1', 'x', 'darwin'), 'wt*');
  assert.equal(ignoringPattern([], '/repo/wt1', 'x', 'darwin'), undefined);
});

test('ignoringPattern: Windows paths match with either slash and any case', () => {
  assert.equal(ignoringPattern(['**/Worktrees/review-*'], 'C:\\Repo\\worktrees\\Review-1', undefined, 'win32'), '**/Worktrees/review-*');
  assert.equal(ignoringPattern(['**\\worktrees\\review-*'], 'C:\\Repo\\worktrees\\review-1', undefined, 'win32'), '**\\worktrees\\review-*');
  assert.equal(ignoringPattern(['review-*'], '/repo/Review-1', undefined, 'linux'), undefined, 'case counts elsewhere');
});

test('suggestIgnorePattern: the last numbered part becomes a wildcard', () => {
  assert.equal(suggestIgnorePattern('/repo/.claude/worktrees/review-mr-203'), 'review-mr-*');
  assert.equal(suggestIgnorePattern('/private/var/folders/cl/x/T/tmp.L3Sq3tW6o2'), 'tmp.*');
  assert.equal(suggestIgnorePattern('/repo/.claude/worktrees/agent_a945a9c5105d5b157/'), 'agent_*');
  assert.equal(suggestIgnorePattern('C:\\Repo\\wt\\review-12'), 'review-*');
});

test('suggestIgnorePattern: a name without a numbered part stays as it is', () => {
  assert.equal(suggestIgnorePattern('/work/repo-feature'), 'repo-feature');
  assert.equal(suggestIgnorePattern('/work/wt3'), 'wt3');
  assert.equal(suggestIgnorePattern('/work/review-[x]-1'), 'review-[[]x[]]-*', 'glob characters in the name are literal');
});
