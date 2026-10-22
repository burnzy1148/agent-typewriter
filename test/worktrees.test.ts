import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  CheckoutChoiceFile,
  carriedProvisional,
  checkoutDisplayPath,
  checkoutName,
  commonDirKey,
  gitdirOf,
  isWorktreeOf,
  listWorktrees,
  liveWorktrees,
  nestedUnder,
  ownCheckout,
  parseWorktreeList,
  relativeInside,
  rootIn,
  worktreeLabels,
  type Worktree,
} from '../src/worktrees';
import type { GitRunner } from '../src/gitBaseline';
import { git, noGit, tempDir, tempRepo, write } from './gitFixture';

const P = (...parts: string[]) => path.resolve('/', ...parts);
const Z = 'worktree list --porcelain -z';
const NL = 'worktree list --porcelain';

function runner(byCommand: Record<string, Buffer | Error>): GitRunner {
  return async (args) => {
    const r = byCommand[args.join(' ')];
    if (r === undefined) throw Object.assign(new Error('unexpected'), { code: 128 });
    if (r instanceof Error) throw r;
    return r;
  };
}

function porcelain(records: string[][], sep: '\0' | '\n'): string {
  return records.map((lines) => lines.map((l) => l + sep).join('') + sep).join('');
}

const RECORDS = [
  [`worktree ${P('repo')}`, 'HEAD 1111111111111111111111111111111111111111', 'branch refs/heads/main'],
  [`worktree ${P('repo', '.claude', 'worktrees', 'feature x')}`, 'HEAD 2222222222222222222222222222222222222222', 'branch refs/heads/claude/feature'],
  [`worktree ${P('elsewhere', 'detached')}`, 'HEAD 3333333333333333333333333333333333333333', 'detached'],
  [`worktree ${P('repo-bare.git')}`, 'bare'],
  [`worktree ${P('gone')}`, 'HEAD 4444444444444444444444444444444444444444', 'detached', 'prunable gitdir file points to non-existent location'],
  [`worktree ${P('locked')}`, 'HEAD 5555555555555555555555555555555555555555', 'branch refs/heads/locked', 'locked reason here'],
];

test('parseWorktreeList: branch, detached, bare and prunable records, both output forms', () => {
  for (const sep of ['\0', '\n'] as const) {
    const list = parseWorktreeList(porcelain(RECORDS, sep), sep);
    assert.deepEqual(
      list.map((w) => [w.path, w.branch, w.head.slice(0, 1), w.prunable]),
      [
        [P('repo'), 'main', '1', undefined],
        [P('repo', '.claude', 'worktrees', 'feature x'), 'claude/feature', '2', undefined],
        [P('elsewhere', 'detached'), undefined, '3', undefined],
        // at-l3q.10.3: a worktree mid-removal is still listed, flagged.
        [P('gone'), undefined, '4', true],
        [P('locked'), 'locked', '5', undefined],
      ],
      `separator ${JSON.stringify(sep)}`,
    );
    assert.deepEqual(
      liveWorktrees(list).map((w) => w.path),
      [P('repo'), P('repo', '.claude', 'worktrees', 'feature x'), P('elsewhere', 'detached'), P('locked')],
    );
  }
  assert.deepEqual(parseWorktreeList(porcelain(RECORDS, '\n').replace(/\n/g, '\r\n'), '\n').length, 5, 'CRLF output');
});

test('listWorktrees: -z, fallback without -z, not-a-repo, git missing', async () => {
  const z = await listWorktrees(P('repo'), runner({ [Z]: Buffer.from(porcelain(RECORDS, '\0')) }));
  assert.ok(z.kind === 'ok' && z.worktrees.length === 5);
  const old = Object.assign(new Error('error: unknown switch `z`'), { code: 129 });
  const nl = await listWorktrees(P('repo'), runner({ [Z]: old, [NL]: Buffer.from(porcelain(RECORDS, '\n')) }));
  assert.ok(nl.kind === 'ok' && nl.worktrees.length === 5);
  const notRepo = Object.assign(new Error('fatal: not a git repository'), { code: 128 });
  assert.deepEqual(await listWorktrees(P('x'), runner({ [Z]: notRepo, [NL]: notRepo })), { kind: 'not-repo' });
  const missing = Object.assign(new Error('spawn git ENOENT'), { code: 'ENOENT' });
  assert.equal((await listWorktrees(P('x'), runner({ [Z]: missing }))).kind, 'unavailable');
});

const MAIN: Worktree = { path: P('repo'), head: 'a'.repeat(40), branch: 'main' };
const NESTED: Worktree = { path: P('repo', '.claude', 'worktrees', 'feature'), head: 'b'.repeat(40), branch: 'feature' };
const DEEP: Worktree = { path: P('repo', 'packages', 'app', '.worktrees', 'fix'), head: 'c'.repeat(40) };
const SIBLING: Worktree = { path: P('repo-sibling'), head: 'd'.repeat(40), branch: 'sibling' };
const ALL = [MAIN, NESTED, DEEP, SIBLING];

test('relativeInside: same, inside, outside, and a sibling sharing a name prefix', () => {
  assert.equal(relativeInside(P('repo'), P('repo')), '');
  assert.equal(relativeInside(P('repo'), P('repo', 'a', 'b')), 'a/b');
  assert.equal(relativeInside(P('repo'), P('repo-sibling')), undefined);
  assert.equal(relativeInside(P('repo', 'a'), P('repo')), undefined);
});

test('ownCheckout: the deepest worktree containing the folder', () => {
  assert.equal(ownCheckout(P('repo'), ALL), MAIN);
  assert.equal(ownCheckout(P('repo', 'packages', 'app'), ALL), MAIN, 'a subdirectory of the checkout');
  assert.equal(ownCheckout(P('repo', '.claude', 'worktrees', 'feature', 'src'), ALL), NESTED);
  assert.equal(ownCheckout(P('repo-sibling'), ALL), SIBLING);
  assert.equal(ownCheckout(P('unrelated'), ALL), undefined);
});

test('nestedUnder: only worktrees strictly inside the root', () => {
  assert.deepEqual(nestedUnder(P('repo'), ALL), ['.claude/worktrees/feature/', 'packages/app/.worktrees/fix/']);
  assert.deepEqual(nestedUnder(P('repo', 'packages', 'app'), ALL), ['.worktrees/fix/']);
  assert.deepEqual(nestedUnder(P('repo-sibling'), ALL), [], 'a sibling is not nested');
  assert.deepEqual(nestedUnder(NESTED.path, ALL), []);
});

test('rootIn: keeps the folder subpath in the chosen checkout', () => {
  assert.equal(rootIn(SIBLING, MAIN, P('repo')), SIBLING.path);
  assert.equal(rootIn(SIBLING, MAIN, P('repo', 'packages', 'app')), P('repo-sibling', 'packages', 'app'));
  assert.equal(rootIn(SIBLING, undefined, P('repo', 'packages', 'app')), SIBLING.path);
});

test('worktreeLabels: directory names, with the parent added on collision', () => {
  const a: Worktree = { path: P('wt', 'one', 'fix'), head: '' };
  const b: Worktree = { path: P('wt', 'two', 'fix'), head: '' };
  const labels = worktreeLabels([MAIN, NESTED, a, b]);
  assert.equal(labels.get(NESTED.path), 'feature');
  assert.equal(labels.get(MAIN.path), 'repo');
  assert.equal(labels.get(a.path), 'one-fix');
  assert.equal(labels.get(b.path), 'two-fix');
});

test('checkoutName: branch, short sha when detached', () => {
  assert.equal(checkoutName(NESTED), 'feature');
  assert.equal(checkoutName(DEEP), 'ccccccc');
  assert.equal(checkoutName({ path: P('x', 'name'), head: '' }), 'name');
});

test('checkoutDisplayPath: worktree label in front, folder name first in multi-root', () => {
  assert.equal(checkoutDisplayPath('', 'feature', 'src/a.ts'), 'feature/src/a.ts');
  assert.equal(checkoutDisplayPath('api', 'feature', 'src/a.ts'), 'api/feature/src/a.ts');
});

test('CheckoutChoiceFile: survives a reload, forgets cleared choices, tolerates a bad file', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'choices-'));
  const file = path.join(dir, 'nested', 'checkouts.json');
  const a = new CheckoutChoiceFile(file);
  assert.equal(a.get('file:///ws'), undefined);
  a.set('file:///ws', P('repo-sibling'));
  a.set('file:///other', P('x'));
  a.set('file:///other', undefined);
  const b = new CheckoutChoiceFile(file);
  assert.equal(b.get('file:///ws'), P('repo-sibling'));
  assert.equal(b.get('file:///other'), undefined);
  fs.writeFileSync(file, '{ broken');
  assert.equal(new CheckoutChoiceFile(file).get('file:///ws'), undefined);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('gitdirOf: the gitdir a .git file names, as written', () => {
  assert.equal(gitdirOf('gitdir: /repo/.git/worktrees/feature\n'), '/repo/.git/worktrees/feature');
  assert.equal(gitdirOf('gitdir: C:/Users/me/repo/.git/worktrees/fix-2\r\n'), 'C:/Users/me/repo/.git/worktrees/fix-2');
  assert.equal(gitdirOf('gitdir: ../../.git/modules/vendor/lib\n'), '../../.git/modules/vendor/lib');
  assert.equal(gitdirOf('[core]\n\tbare = false\n'), undefined);
});

test('relativeInside: keeps the child path as written, not case-folded', () => {
  assert.equal(relativeInside(P('Repo'), P('Repo', '.worktrees', 'Fix-Bug')), '.worktrees/Fix-Bug');
});

// --- at-l3q.10.8: only a git that ran and failed means not a repository.

test('listWorktrees: spawn failures, a synchronous throw and timeouts are unavailable; a git exit code is not-repo', async () => {
  const spawnError = (code: string) => Object.assign(new Error(`spawn git ${code}`), { code, syscall: 'spawn git', errno: -11 });
  for (const code of ['EAGAIN', 'EMFILE', 'ENFILE', 'ENOMEM']) {
    const r = await listWorktrees(P('repo'), runner({ [Z]: spawnError(code), [NL]: spawnError(code) }));
    assert.equal(r.kind, 'unavailable', code);
  }
  const killed = Object.assign(new Error('timed out'), { killed: true, signal: 'SIGTERM', code: null });
  assert.equal((await listWorktrees(P('repo'), runner({ [Z]: killed, [NL]: killed }))).kind, 'unavailable', 'timeout');
  const sync: GitRunner = () => {
    throw new Error('spawn failed synchronously');
  };
  assert.equal((await listWorktrees(P('repo'), sync)).kind, 'unavailable', 'synchronous throw');
  // A spawn failure after -z failed with an exit code is unavailable too.
  const old = Object.assign(new Error('error: unknown switch `z`'), { code: 129 });
  assert.equal((await listWorktrees(P('repo'), runner({ [Z]: old, [NL]: spawnError('EAGAIN') }))).kind, 'unavailable');
  const notRepo = Object.assign(new Error('fatal: not a git repository'), { code: 128 });
  assert.equal((await listWorktrees(P('x'), runner({ [Z]: notRepo, [NL]: notRepo }))).kind, 'not-repo');
  const noCwd = Object.assign(new Error('not a directory'), { code: 'ENOCWD' });
  assert.equal((await listWorktrees(P('x'), runner({ [Z]: noCwd }))).kind, 'not-repo', 'a missing folder');
  const denied = Object.assign(new Error('spawn git EACCES'), { code: 'EACCES' });
  assert.equal((await listWorktrees(P('x'), runner({ [Z]: denied }))).kind, 'unavailable');
});

// --- at-l3q.10.3: a worktree whose .git is gone is still listed, and still nested.

test('listWorktrees: a nested worktree whose .git file is deleted is still listed, as prunable', { skip: noGit }, async () => {
  const repo = tempRepo('at-wt-');
  write(repo, 'a.ts', 'a\n');
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', 'initial');
  git(repo, 'worktree', 'add', '-q', '-b', 'feature', path.join('.claude', 'worktrees', 'feature'));
  fs.rmSync(path.join(repo, '.claude', 'worktrees', 'feature', '.git'));
  const r = await listWorktrees(repo);
  assert.ok(r.kind === 'ok');
  const feature = r.worktrees.find((w) => w.path.endsWith('feature'));
  assert.equal(feature?.prunable, true);
  assert.deepEqual(nestedUnder(repo, r.worktrees), ['.claude/worktrees/feature/']);
  assert.deepEqual(liveWorktrees(r.worktrees).length, 1);
});

// --- at-l3q.10.7: a .git file hides its directory only when it is a worktree of the folder's repository.

test('isWorktreeOf: own worktrees (absolute or relative gitdir), not another repository\'s or a submodule under worktrees/', { skip: noGit }, () => {
  const ws = tempRepo('at-wt-ws-');
  write(ws, 'a.ts', 'a\n');
  git(ws, 'add', '-A');
  git(ws, 'commit', '-q', '-m', 'initial');
  const common = commonDirKey(ws)!;
  assert.ok(common);
  git(ws, 'worktree', 'add', '-q', '-b', 'late', path.join('.worktrees', 'late'));
  const late = path.join(ws, '.worktrees', 'late', '.git');
  assert.ok(isWorktreeOf(late, common));
  assert.equal(commonDirKey(path.join(ws, '.worktrees', 'late')), common, 'a linked worktree has the same common directory');
  // worktree.useRelativePaths writes a relative gitdir.
  const relDir = path.join(ws, '.worktrees', 'rel');
  fs.mkdirSync(relDir, { recursive: true });
  fs.writeFileSync(path.join(relDir, '.git'), 'gitdir: ../../.git/worktrees/rel\n');
  assert.ok(isWorktreeOf(path.join(relDir, '.git'), common));

  const other = tempRepo('at-wt-b-');
  write(other, 'f.ts', 'f\n');
  git(other, 'add', '-A');
  git(other, 'commit', '-q', '-m', 'initial');
  git(other, 'worktree', 'add', '-q', '-b', 'bwt', path.join(ws, 'tmp', 'bwt'));
  assert.ok(!isWorktreeOf(path.join(ws, 'tmp', 'bwt', '.git'), common), "another repository's worktree");

  git(ws, '-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', other, 'worktrees/foo');
  assert.match(fs.readFileSync(path.join(ws, 'worktrees', 'foo', '.git'), 'utf8'), /modules[\\/]worktrees[\\/]foo/);
  assert.ok(!isWorktreeOf(path.join(ws, 'worktrees', 'foo', '.git'), common), 'a submodule named worktrees/foo');
  assert.ok(!isWorktreeOf(path.join(ws, '.git'), common), 'a .git directory');
  assert.ok(!isWorktreeOf(path.join(ws, 'missing', '.git'), common));
});

// --- at-l3q.10.4: provisional worktrees noticed during a listing outlive the scope it builds.

test('carriedProvisional: keeps entries noticed after the listing started that git did not list', () => {
  const entries = [
    { dir: '.worktrees/a/', seq: 1 },
    { dir: '.worktrees/b/', seq: 3 },
    { dir: '.worktrees/c/', seq: 4 },
  ];
  // The listing started at 2: a is settled by it, b and c may have been missed; git listed c.
  assert.deepEqual(carriedProvisional(entries, 2, ['.worktrees/c/']), [{ dir: '.worktrees/b/', seq: 3 }]);
  assert.deepEqual(carriedProvisional(entries, 0, ['.worktrees/a/', '.worktrees/b/', '.worktrees/c/']), [], 'none duplicated');
  assert.deepEqual(carriedProvisional(entries, 4, []), [], 'all older than the listing');
});

// --- at-l3q.10.5: saving the choice never throws.

test('CheckoutChoiceFile: a choice that cannot be saved is kept for the session and reported', () => {
  const dir = tempDir('choices-');
  const file = path.join(dir, 'storage', 'checkouts.json');
  const a = new CheckoutChoiceFile(file);
  assert.equal(a.set('file:///ws', P('repo-sibling')), undefined);
  // The storage directory's parent becomes a file, so nothing can be written there.
  fs.rmSync(path.join(dir, 'storage'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'storage'), 'not a directory');
  const blocked = new CheckoutChoiceFile(file);
  assert.equal(blocked.get('file:///ws'), undefined);
  let err: Error | undefined;
  assert.doesNotThrow(() => (err = blocked.set('file:///ws', P('other'))));
  assert.ok(err instanceof Error);
  assert.equal(blocked.get('file:///ws'), P('other'));
  assert.ok(blocked.set('file:///ws', undefined) instanceof Error);
  assert.equal(blocked.get('file:///ws'), undefined);
  fs.rmSync(dir, { recursive: true, force: true });
});
