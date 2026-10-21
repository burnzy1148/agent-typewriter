import { test } from 'node:test';
import assert from 'node:assert/strict';
import { IgnoredPaths, checkIgnored, listIgnored } from '../src/gitIgnore';
import type { GitRunner } from '../src/gitBaseline';

const LS = 'ls-files --others --ignored --exclude-standard --directory -z';

function runner(byCommand: Record<string, Buffer | Error>): GitRunner {
  return async (args) => {
    const r = byCommand[args.join(' ')];
    if (r === undefined) throw Object.assign(new Error('unexpected'), { code: 128 });
    if (r instanceof Error) throw r;
    return r;
  };
}

test('IgnoredPaths: files exactly, directories as prefixes', () => {
  const p = new IgnoredPaths(['a.log', 'node_modules/', 'src/gen/', 'src/b.log']);
  assert.ok(p.has('a.log'));
  assert.ok(p.has('src/b.log'));
  assert.ok(p.has('node_modules/x/index.js'));
  assert.ok(p.has('src/gen/deep/file.ts'));
  assert.ok(!p.has('node_modulesx/a.js'), 'a directory entry is not a bare string prefix');
  assert.ok(!p.has('src/a.log'));
  assert.ok(!p.has('b.log'));
  p.add('later.log');
  assert.ok(p.has('later.log'));
});

test('listIgnored: parses NUL-separated output, paths with spaces', async () => {
  const r = await listIgnored('/ws', runner({ [LS]: Buffer.from('dist/\0my notes.log\0') }));
  assert.equal(r.kind, 'ok');
  assert.ok(r.kind === 'ok' && r.ignored.has('dist/out.js') && r.ignored.has('my notes.log'));
});

test('listIgnored: not a repository, git missing', async () => {
  const notRepo = Object.assign(new Error('fatal: not a git repository'), { code: 128 });
  assert.deepEqual(await listIgnored('/ws', runner({ [LS]: notRepo })), { kind: 'not-repo' });
  const missing = Object.assign(new Error('spawn git ENOENT'), { code: 'ENOENT' });
  assert.equal((await listIgnored('/ws', runner({ [LS]: missing }))).kind, 'unavailable');
});

test('checkIgnored: exit 0 is ignored, exit 1 or failure is not', async () => {
  const run = runner({
    'check-ignore -q -- new.log': Buffer.alloc(0),
    'check-ignore -q -- src/a.ts': Object.assign(new Error('exit 1'), { code: 1 }),
  });
  assert.equal(await checkIgnored('/ws', 'new.log', run), true);
  assert.equal(await checkIgnored('/ws', 'src/a.ts', run), false);
  assert.equal(await checkIgnored('/ws', 'other', run), false);
});
