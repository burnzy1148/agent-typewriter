import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  classifyClean,
  listCleanTracked,
  parseLsFiles,
  parsePathList,
  readBlob,
  selectWithinBudget,
  type GitRunner,
} from '../src/gitBaseline';

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
    'ls-files -s -z': Buffer.from(`100644 ${SHA_A} 0\ta.ts\x00100644 ${SHA_B} 0\tb.ts\0`),
    'ls-files -m -z': Buffer.from('b.ts\0'),
  });
  const r = await listCleanTracked('/ws', run);
  assert.equal(r.kind, 'ok');
  assert.deepEqual(r.kind === 'ok' && [...r.files], [['a.ts', SHA_A]]);
});

test('listCleanTracked: not a repository', async () => {
  const notRepo = Object.assign(new Error('fatal: not a git repository'), { code: 128 });
  const { run } = fakeRunner({ 'ls-files -s -z': notRepo, 'ls-files -m -z': notRepo });
  assert.deepEqual(await listCleanTracked('/ws', run), { kind: 'not-repo' });
});

test('listCleanTracked: git not installed is unavailable, not not-repo', async () => {
  const missing = Object.assign(new Error('spawn git ENOENT'), { code: 'ENOENT' });
  const { run } = fakeRunner({ 'ls-files -s -z': missing, 'ls-files -m -z': missing });
  assert.equal((await listCleanTracked('/ws', run)).kind, 'unavailable');
});

test('listCleanTracked: a timed-out git is unavailable', async () => {
  const timedOut = Object.assign(new Error('timed out'), { killed: true, signal: 'SIGTERM' });
  const { run } = fakeRunner({ 'ls-files -s -z': timedOut, 'ls-files -m -z': timedOut });
  assert.equal((await listCleanTracked('/ws', run)).kind, 'unavailable');
});

test('readBlob: runs cat-file with filters and the path, undefined on failure', async () => {
  const { run, calls } = fakeRunner({ [`cat-file --filters --path=src/a.ts ${SHA_A}`]: Buffer.from('hi\n') });
  assert.equal((await readBlob('/ws', 'src/a.ts', SHA_A, run))?.toString(), 'hi\n');
  assert.deepEqual(calls[0], ['cat-file', '--filters', '--path=src/a.ts', SHA_A]);
  assert.equal(await readBlob('/ws', 'src/b.ts', SHA_B, run), undefined);
});
