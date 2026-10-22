import { test } from 'node:test';
import assert from 'node:assert/strict';
import { IgnoredPaths, checkIgnored, dropCollapsedDirs, listIgnored } from '../src/gitIgnore';
import type { GitRunner } from '../src/gitBaseline';
import { git, noGit, tempRepo, write } from './gitFixture';

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

test('dropCollapsedDirs: drops a dir/ only when entries are listed under it', () => {
  assert.deepEqual(
    dropCollapsedDirs(['star/x.txt', 'logs/', 'gen/', 'logs/run.log', 'a/', 'a/node_modules/', 'star/', 'b.log', 'logsx/']),
    ['a/node_modules/', 'b.log', 'gen/', 'logs/run.log', 'logsx/', 'star/x.txt'],
  );
  assert.deepEqual(dropCollapsedDirs([]), []);
});

test('listIgnored: a directory git lists only because its contents are ignored is not ignored itself', async () => {
  const r = await listIgnored('/ws', runner({ [LS]: Buffer.from('logs/\0logs/run.log\0star/\0star/x.txt\0gen/\0') }));
  assert.equal(r.kind, 'ok');
  if (r.kind !== 'ok') return;
  assert.equal(r.ignored.has('logs/'), false);
  assert.equal(r.ignored.has('logs/README.md'), false);
  assert.equal(r.ignored.has('logs/run.log'), true);
  assert.equal(r.ignored.has('star/keep.md'), false);
  assert.equal(r.ignored.has('star/x.txt'), true);
  assert.equal(r.ignored.has('gen/a.ts'), true);
});

test('listIgnored (real git): new files in an untracked directory of ignored files are not ignored', { skip: noGit }, async () => {
  const repo = tempRepo();
  write(repo, '.gitignore', '*.log\nnode_modules/\ngen\nstar/*\n!star/keep.md\n');
  git(repo, 'add', '.');
  git(repo, 'commit', '-q', '-m', 'init');
  write(repo, 'logs/run.log', 'x\n');
  write(repo, 'node_modules/x/i.js', 'x\n');
  write(repo, 'gen/a.ts', 'x\n');
  write(repo, 'star/x.txt', 'x\n');
  write(repo, 'logs/sub/x.log', 'x\n');
  write(repo, 'a/node_modules/x/i.js', 'x\n');
  const r = await listIgnored(repo);
  assert.equal(r.kind, 'ok');
  if (r.kind !== 'ok') return;
  write(repo, 'logs/README.md', 'x\n');
  assert.equal(await checkIgnored(repo, 'logs/README.md'), false);
  assert.equal(r.ignored.has('logs/README.md'), false);
  assert.equal(r.ignored.has('logs/'), false);
  assert.equal(r.ignored.has('logs/run.log'), true);
  assert.equal(r.ignored.has('node_modules/'), true);
  assert.equal(r.ignored.has('node_modules/x/i.js'), true);
  assert.equal(r.ignored.has('gen/b.ts'), true);
  assert.equal(r.ignored.has('star/keep.md'), false);
  assert.equal(r.ignored.has('star/x.txt'), true);
  assert.equal(r.ignored.has('logs/sub/new.md'), false);
  assert.equal(r.ignored.has('logs/sub/x.log'), true);
  assert.equal(r.ignored.has('a/new.md'), false);
  assert.equal(r.ignored.has('a/node_modules/x/i.js'), true);
});

test('checkIgnored (real git): a leading colon is a file name, not pathspec magic', { skip: noGit ?? (process.platform === 'win32' && 'colons are not allowed in Windows file names') }, async () => {
  const repo = tempRepo();
  write(repo, '.gitignore', '/foo\n*.log\n');
  write(repo, ':foo/a.log', 'x\n');
  write(repo, ':foo/b.md', 'x\n');
  assert.equal(await checkIgnored(repo, ':foo'), false);
  assert.equal(await checkIgnored(repo, ':foo/b.md'), false);
  assert.equal(await checkIgnored(repo, ':foo/a.log'), true);
  write(repo, 'foo/b.md', 'x\n');
  assert.equal(await checkIgnored(repo, 'foo'), true);
});

test('listIgnored: not a repository, git missing', async () => {
  const notRepo = Object.assign(new Error('fatal: not a git repository'), { code: 128 });
  assert.deepEqual(await listIgnored('/ws', runner({ [LS]: notRepo })), { kind: 'not-repo' });
  const missing = Object.assign(new Error('spawn git ENOENT'), { code: 'ENOENT' });
  assert.equal((await listIgnored('/ws', runner({ [LS]: missing }))).kind, 'unavailable');
});

test('checkIgnored: exit 0 is ignored, exit 1 or failure is not', async () => {
  const run = runner({
    'check-ignore -q -- ./new.log': Buffer.alloc(0),
    'check-ignore -q -- ./src/a.ts': Object.assign(new Error('exit 1'), { code: 1 }),
  });
  assert.equal(await checkIgnored('/ws', 'new.log', run), true);
  assert.equal(await checkIgnored('/ws', 'src/a.ts', run), false);
  assert.equal(await checkIgnored('/ws', 'other', run), false);
});
