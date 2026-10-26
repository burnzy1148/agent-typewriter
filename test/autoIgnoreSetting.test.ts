import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readSettings, setRepoValues } from '../src/config';
import { mock } from './vscode-mock';

test('autoIgnoreWorktrees: empty by default, read from settings or the repository file', () => {
  mock.reset();
  setRepoValues({});
  assert.deepEqual(readSettings().autoIgnoreWorktrees, []);
  setRepoValues({ autoIgnoreWorktrees: ['review-*'] });
  assert.deepEqual(readSettings().autoIgnoreWorktrees, ['review-*']);
  mock.set('agentTypewriter.autoIgnoreWorktrees', ['**/T/tmp.*']);
  assert.deepEqual(readSettings().autoIgnoreWorktrees, ['**/T/tmp.*'], 'a workspace setting wins over the file');
  mock.set('agentTypewriter.autoIgnoreWorktrees', 'review-*');
  assert.deepEqual(readSettings().autoIgnoreWorktrees, ['review-*'], 'a wrong-typed setting counts as unset');
  setRepoValues({});
  mock.reset();
});
