import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  classifyClean,
  execGit,
  gitChildEnv,
  isGitUnavailable,
  limitGit,
  listCleanTracked,
  parseLsFiles,
  parsePathList,
  readBlob,
  selectWithinBudget,
  type GitRunner,
} from '../src/gitBaseline';
import { checkIgnored, listIgnored } from '../src/gitIgnore';
import { listWorktrees } from '../src/worktrees';
import { git, noGit, tempDir, tempRepo, write } from './gitFixture';

const SHA_A = 'a'.repeat(40);
const SHA_B = 'b'.repeat(40);
const SHA_C = 'c'.repeat(40);

test('parseLsFiles: NUL records with tabs and spaces in paths', () => {
  const out = `100644 ${SHA_A} 0\tsrc/a.ts\x00100755 ${SHA_B} 0\tsrc/my file.ts\0`;
  assert.deepEqual(parseLsFiles(out), [
    { mode: '100644', sha: SHA_A, stage: 0, path: 'src/a.ts' },
    { mode: '100755', sha: SHA_B, stage: 0, path: 'src/my file.ts' },
  ]);
});

test('parseLsFiles: ignores empty and malformed records', () => {
  assert.deepEqual(parseLsFiles(''), []);
  assert.deepEqual(parseLsFiles('garbage\0\0'), []);
});

test('parsePathList: NUL-separated paths', () => {
  assert.deepEqual(parsePathList('a.ts\0dir/b c.ts\0'), new Set(['a.ts', 'dir/b c.ts']));
  assert.deepEqual(parsePathList(''), new Set());
});

test('classifyClean: keeps stage-0 regular files that are not modified', () => {
  const entries = parseLsFiles(
    [
      `100644 ${SHA_A} 0\tclean.ts`,
      `100644 ${SHA_B} 0\tdirty.ts`,
      `100755 ${SHA_C} 0\tscript.sh`,
      `120000 ${SHA_A} 0\tlink.ts`,
      `160000 ${SHA_B} 0\tvendor/sub`,
      `100644 ${SHA_A} 1\tconflict.ts`,
      `100644 ${SHA_B} 2\tconflict.ts`,
      `100644 ${SHA_C} 3\tconflict.ts`,
    ].join('\0'),
  );
  const clean = classifyClean(entries, new Set(['dirty.ts']));
  assert.deepEqual([...clean.entries()], [
    ['clean.ts', SHA_A],
    ['script.sh', SHA_C],
  ]);
});

test('parseLsFiles: -v tags are kept, and classifyClean keeps only H entries', () => {
  const entries = parseLsFiles(`h 100644 ${SHA_A} 0\ta.cfg\0S 100644 ${SHA_B} 0\tb.cfg\0H 100644 ${SHA_C} 0\tc.cfg\0`);
  assert.deepEqual(entries, [
    { tag: 'h', mode: '100644', sha: SHA_A, stage: 0, path: 'a.cfg' },
    { tag: 'S', mode: '100644', sha: SHA_B, stage: 0, path: 'b.cfg' },
    { tag: 'H', mode: '100644', sha: SHA_C, stage: 0, path: 'c.cfg' },
  ]);
  assert.deepEqual([...classifyClean(entries, new Set())], [['c.cfg', SHA_C]]);
});

test('selectWithinBudget: newest first until the budget is spent', () => {
  const c = [
    { key: 'old', size: 40, mtime: 1 },
    { key: 'new', size: 40, mtime: 3 },
    { key: 'mid', size: 40, mtime: 2 },
  ];
  assert.deepEqual(selectWithinBudget(c, 80), new Set(['new', 'mid']));
});

test('selectWithinBudget: exact fit', () => {
  assert.deepEqual(selectWithinBudget([{ key: 'a', size: 100, mtime: 1 }], 100), new Set(['a']));
});

test('selectWithinBudget: a single file over budget is skipped, smaller ones still fit', () => {
  const c = [
    { key: 'huge', size: 500, mtime: 9 },
    { key: 'small', size: 10, mtime: 1 },
  ];
  assert.deepEqual(selectWithinBudget(c, 100), new Set(['small']));
});

test('selectWithinBudget: zero budget selects nothing but empty files', () => {
  const c = [
    { key: 'a', size: 1, mtime: 1 },
    { key: 'empty', size: 0, mtime: 2 },
  ];
  assert.deepEqual(selectWithinBudget(c, 0), new Set(['empty']));
});

function fakeRunner(byCommand: Record<string, Buffer | Error>): { run: GitRunner; calls: string[][] } {
  const calls: string[][] = [];
  const run: GitRunner = async (args) => {
    calls.push(args);
    const r = byCommand[args.join(' ')];
    if (r === undefined) throw Object.assign(new Error('unexpected'), { code: 128 });
    if (r instanceof Error) throw r;
    return r;
  };
  return { run, calls };
}

test('listCleanTracked: success', async () => {
  const { run } = fakeRunner({
    'ls-files -s -v -z': Buffer.from(`H 100644 ${SHA_A} 0\ta.ts\x00H 100644 ${SHA_B} 0\tb.ts\0`),
    'ls-files -m -z': Buffer.from('b.ts\0'),
  });
  const r = await listCleanTracked('/ws', run);
  assert.equal(r.kind, 'ok');
  assert.deepEqual(r.kind === 'ok' && [...r.files], [['a.ts', SHA_A]]);
});

test('listCleanTracked: not a repository', async () => {
  const notRepo = Object.assign(new Error('fatal: not a git repository'), { code: 128 });
  const { run } = fakeRunner({ 'ls-files -s -v -z': notRepo, 'ls-files -m -z': notRepo });
  assert.deepEqual(await listCleanTracked('/ws', run), { kind: 'not-repo' });
});

test('listCleanTracked: git not installed is unavailable, not not-repo', async () => {
  const missing = Object.assign(new Error('spawn git ENOENT'), { code: 'ENOENT' });
  const { run } = fakeRunner({ 'ls-files -s -v -z': missing, 'ls-files -m -z': missing });
  assert.equal((await listCleanTracked('/ws', run)).kind, 'unavailable');
});

test('listCleanTracked: a timed-out git is unavailable', async () => {
  const timedOut = Object.assign(new Error('timed out'), { killed: true, signal: 'SIGTERM' });
  const { run } = fakeRunner({ 'ls-files -s -v -z': timedOut, 'ls-files -m -z': timedOut });
  assert.equal((await listCleanTracked('/ws', run)).kind, 'unavailable');
});

test('readBlob: passes the repo-relative path to cat-file, undefined on failure', async () => {
  const { run, calls } = fakeRunner({
    'rev-parse --show-prefix': Buffer.from('packages/app/\n'),
    [`cat-file --filters --path=packages/app/src/a.ts ${SHA_A}`]: Buffer.from('hi\n'),
  });
  assert.equal((await readBlob('/ws/packages/app', 'src/a.ts', SHA_A, run))?.toString(), 'hi\n');
  assert.deepEqual(calls, [
    ['rev-parse', '--show-prefix'],
    ['cat-file', '--filters', '--path=packages/app/src/a.ts', SHA_A],
  ]);
  assert.equal(await readBlob('/ws/packages/app', 'src/b.ts', SHA_B, run), undefined);
});

test('readBlob: at the top level the prefix is empty', async () => {
  const { run, calls } = fakeRunner({
    'rev-parse --show-prefix': Buffer.from('\n'),
    [`cat-file --filters --path=src/a.ts ${SHA_A}`]: Buffer.from('hi\n'),
  });
  assert.equal((await readBlob('/ws', 'src/a.ts', SHA_A, run))?.toString(), 'hi\n');
  assert.deepEqual(calls[1], ['cat-file', '--filters', '--path=src/a.ts', SHA_A]);
});

test('readBlob: looks the prefix up once per folder, again after a failed read', async () => {
  const { run, calls } = fakeRunner({
    'rev-parse --show-prefix': Buffer.from('app/\n'),
    [`cat-file --filters --path=app/a.ts ${SHA_A}`]: Buffer.from('a'),
    [`cat-file --filters --path=app/b.ts ${SHA_B}`]: Buffer.from('b'),
  });
  await Promise.all([readBlob('/ws/app', 'a.ts', SHA_A, run), readBlob('/ws/app', 'b.ts', SHA_B, run)]);
  assert.equal(calls.filter((c) => c[0] === 'rev-parse').length, 1);
  assert.equal(await readBlob('/ws/app', 'c.ts', SHA_C, run), undefined);
  await readBlob('/ws/app', 'a.ts', SHA_A, run);
  assert.equal(calls.filter((c) => c[0] === 'rev-parse').length, 2);
});

test('readBlob: undefined when rev-parse fails', async () => {
  const { run, calls } = fakeRunner({ [`cat-file --filters --path=src/a.ts ${SHA_A}`]: Buffer.from('hi\n') });
  assert.equal(await readBlob('/ws', 'src/a.ts', SHA_A, run), undefined);
  assert.equal(calls.length, 1);
});

test('readBlob (real git): a repo subdirectory gets its own and anchored attributes', { skip: noGit }, async () => {
  const repo = tempRepo();
  write(repo, 'packages/app/.gitattributes', '*.txt ident\n');
  write(repo, 'packages/app/b.txt', 'v $Id$\n');
  write(repo, '.gitattributes', 'packages/app/c.md ident\n');
  write(repo, 'packages/app/c.md', 'c $Id$\n');
  git(repo, 'add', '.');
  git(repo, 'commit', '-q', '-m', 'init');
  const app = path.join(repo, 'packages', 'app');
  for (const f of ['b.txt', 'c.md']) fs.rmSync(path.join(app, f));
  git(repo, 'checkout', '--', '.');
  const r = await listCleanTracked(app);
  assert.equal(r.kind, 'ok');
  if (r.kind !== 'ok') return;
  for (const f of ['b.txt', 'c.md']) {
    const disk = fs.readFileSync(path.join(app, f));
    assert.match(disk.toString(), /\$Id: [0-9a-f]+ \$/, `${f} is expanded on disk`);
    const sha = r.files.get(f);
    assert.ok(sha, `${f} is clean tracked`);
    assert.deepEqual(await readBlob(app, f, sha), disk, `${f} baseline matches disk`);
  }
});

test('listCleanTracked (real git): skip-worktree and assume-unchanged files are never clean', { skip: noGit }, async () => {
  const repo = tempRepo();
  for (const f of ['a.cfg', 'b.cfg', 'c.cfg']) write(repo, f, 'orig\n');
  git(repo, 'add', '.');
  git(repo, 'commit', '-q', '-m', 'init');
  git(repo, 'update-index', '--assume-unchanged', 'a.cfg');
  git(repo, 'update-index', '--skip-worktree', 'b.cfg');
  const r = await listCleanTracked(repo);
  assert.deepEqual(r.kind === 'ok' && [...r.files.keys()], ['c.cfg']);
  for (const f of ['a.cfg', 'b.cfg']) write(repo, f, 'local\n');
  const after = await listCleanTracked(repo);
  assert.deepEqual(after.kind === 'ok' && [...after.files.keys()], ['c.cfg']);
});

test('a missing folder is not-repo, not "git cannot run"', async () => {
  const missing = path.join(os.tmpdir(), `at-missing-${process.pid}-${Date.now()}`, 'dir');
  const err = await execGit(['ls-files', '-s', '-z'], missing).then(
    () => undefined,
    (e: unknown) => e,
  );
  assert.ok(err, 'execGit rejects');
  assert.equal((err as { code?: unknown }).code, 'ENOCWD');
  assert.equal(isGitUnavailable(err), false);
  assert.deepEqual(await listCleanTracked(missing), { kind: 'not-repo' });
  assert.deepEqual(await listWorktrees(missing), { kind: 'not-repo' });
  assert.deepEqual(await listIgnored(missing), { kind: 'not-repo' });
});

test('execGit: a file as cwd is not-repo too', async () => {
  const file = path.join(tempDir('at-file-'), 'f');
  fs.writeFileSync(file, '');
  assert.deepEqual(await listCleanTracked(file), { kind: 'not-repo' });
});

test('gitChildEnv: drops repository-selection variables, keeps the rest', () => {
  const env = { GIT_DIR: '/x/.git', GIT_INDEX_FILE: '/x/.git/index.lock', GIT_WORK_TREE: '/x', FOO: 'bar' };
  assert.deepEqual(gitChildEnv(env, 'linux'), { FOO: 'bar', GIT_TERMINAL_PROMPT: '0' });
  const kept = { PATH: '/bin', HOME: '/h', GIT_SSH: 'ssh', GIT_TERMINAL_PROMPT: '1' };
  assert.deepEqual(gitChildEnv(kept, 'linux'), { ...kept, GIT_TERMINAL_PROMPT: '0' });
});

test('gitChildEnv: names match case-insensitively on Windows only', () => {
  const env = { Git_Dir: 'C:/x/.git', git_index_file: 'i', GIT_COMMON_DIR: 'c', Path: 'C:/bin' };
  assert.deepEqual(gitChildEnv(env, 'win32'), { Path: 'C:/bin', GIT_TERMINAL_PROMPT: '0' });
  assert.deepEqual(gitChildEnv(env, 'linux'), { Git_Dir: 'C:/x/.git', git_index_file: 'i', Path: 'C:/bin', GIT_TERMINAL_PROMPT: '0' });
});

test('git helpers (real git) ignore an inherited GIT_DIR and GIT_INDEX_FILE', { skip: noGit }, async () => {
  const repo = tempRepo();
  write(repo, '.gitignore', '*.cfg\n');
  write(repo, 'app.cfg', 'cfg\n');
  write(repo, 'main.ts', 'main\n');
  git(repo, 'add', '.gitignore', 'main.ts');
  git(repo, 'add', '-f', 'app.cfg');
  git(repo, 'commit', '-q', '-m', 'init');
  git(repo, 'worktree', 'add', '-q', path.join(repo, '.claude', 'worktrees', 'feature'));
  const other = tempRepo();
  write(other, 'x.ts', 'x\n');
  git(other, 'add', '.');
  git(other, 'commit', '-q', '-m', 'init');
  const otherWt = path.join(tempDir('at-otherwt-'), 'otherwt');
  git(other, 'worktree', 'add', '-q', otherWt);

  const saved = { GIT_DIR: process.env.GIT_DIR, GIT_INDEX_FILE: process.env.GIT_INDEX_FILE };
  process.env.GIT_DIR = path.join(other, '.git', 'worktrees', 'otherwt');
  process.env.GIT_INDEX_FILE = path.join(other, '.git', 'index.lock');
  try {
    const clean = await listCleanTracked(repo);
    assert.deepEqual(clean.kind === 'ok' && [...clean.files.keys()].sort(), ['.gitignore', 'app.cfg', 'main.ts']);
    const ignored = await listIgnored(repo);
    assert.equal(ignored.kind, 'ok');
    assert.equal(ignored.kind === 'ok' && ignored.ignored.has('app.cfg'), false);
    assert.equal(await checkIgnored(repo, 'app.cfg'), false);
    const wts = await listWorktrees(repo);
    assert.deepEqual(wts.kind === 'ok' && wts.worktrees.map((w) => path.basename(w.path)), [path.basename(repo), 'feature']);
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
});

const FAST = { concurrency: 4, attempts: 3, backoffMs: 1 };
const spawnError = (code: string | number) => Object.assign(new Error(`spawn failed: ${code}`), { code });

test('limitGit: at most `concurrency` calls run at once, in FIFO order, each with its own output', async () => {
  let inFlight = 0;
  let peak = 0;
  const started: string[] = [];
  const fake: GitRunner = async (args) => {
    started.push(args[0]);
    inFlight++;
    peak = Math.max(peak, inFlight);
    await new Promise((r) => setTimeout(r, Math.random() * 3));
    inFlight--;
    return Buffer.from(args[0]);
  };
  const run = limitGit(fake, FAST);
  const ids = Array.from({ length: 200 }, (_, i) => String(i));
  const out = await Promise.all(ids.map((id) => run([id], '/ws')));
  assert.ok(peak <= FAST.concurrency, `peak ${peak}`);
  assert.equal(peak, FAST.concurrency);
  assert.deepEqual(out.map(String), ids);
  assert.deepEqual(started, ids);
});

test('limitGit: transient spawn failures are retried', async () => {
  let n = 0;
  const blobRun = limitGit(async (args) => {
    if (++n <= 2) throw spawnError('EAGAIN');
    return Buffer.from(args[0] === 'rev-parse' ? '\n' : 'hi\n');
  }, FAST);
  assert.equal((await readBlob('/ws', 'a.ts', SHA_A, blobRun))?.toString(), 'hi\n');
  assert.equal(n, 4);
  for (const code of ['EAGAIN', 'EMFILE', 'ENFILE']) {
    n = 0;
    const run = limitGit(async () => {
      if (++n <= 2) throw spawnError(code);
      return Buffer.alloc(0);
    }, FAST);
    assert.equal(await checkIgnored('/ws', 'build.log', run), true, code);
    assert.equal(n, 3);
  }
});

test('limitGit: a spawn that keeps failing transiently rejects after the bounded attempts', async () => {
  let n = 0;
  const run = limitGit(async () => {
    n++;
    throw spawnError('EAGAIN');
  }, FAST);
  await assert.rejects(run(['ls-files'], '/ws'), { code: 'EAGAIN' });
  assert.equal(n, FAST.attempts);
});

test('limitGit: failed calls give their slot back', async () => {
  let n = 0;
  const run = limitGit(async () => {
    if (++n <= 3) throw spawnError(n === 1 ? 'EAGAIN' : 128);
    return Buffer.from('ok');
  }, { concurrency: 1, attempts: 1, backoffMs: 1 });
  for (let i = 0; i < 3; i++) await assert.rejects(run(['x'], '/ws'));
  assert.equal((await run(['x'], '/ws')).toString(), 'ok');
});

test('limitGit: git exit codes, ENOENT, EACCES and timeouts are not retried', async () => {
  const errors = [spawnError(1), spawnError(128), spawnError('ENOENT'), spawnError('EACCES'), Object.assign(new Error('timed out'), { killed: true })];
  for (const e of errors) {
    let n = 0;
    const run = limitGit(async () => {
      n++;
      throw e;
    }, FAST);
    await assert.rejects(run(['ls-files'], '/ws'), (err) => err === e);
    assert.equal(n, 1, e.message);
  }
  assert.equal(isGitUnavailable(spawnError('EAGAIN')), false);
});
