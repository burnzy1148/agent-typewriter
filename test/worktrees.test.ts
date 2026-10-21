import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  CheckoutChoiceFile,
  checkoutDisplayPath,
  checkoutName,
  listWorktrees,
  nestedUnder,
  ownCheckout,
  parseWorktreeList,
  pointsAtLinkedWorktree,
  relativeInside,
  rootIn,
  worktreeLabels,
  type Worktree,
} from '../src/worktrees';
import type { GitRunner } from '../src/gitBaseline';

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
      list.map((w) => [w.path, w.branch, w.head.slice(0, 1)]),
      [
        [P('repo'), 'main', '1'],
        [P('repo', '.claude', 'worktrees', 'feature x'), 'claude/feature', '2'],
        [P('elsewhere', 'detached'), undefined, '3'],
        [P('locked'), 'locked', '5'],
      ],
      `separator ${JSON.stringify(sep)}`,
    );
  }
  assert.deepEqual(parseWorktreeList(porcelain(RECORDS, '\n').replace(/\n/g, '\r\n'), '\n').length, 4, 'CRLF output');
});

test('listWorktrees: -z, fallback without -z, not-a-repo, git missing', async () => {
  const z = await listWorktrees(P('repo'), runner({ [Z]: Buffer.from(porcelain(RECORDS, '\0')) }));
  assert.ok(z.kind === 'ok' && z.worktrees.length === 4);
  const old = Object.assign(new Error('error: unknown switch `z`'), { code: 129 });
  const nl = await listWorktrees(P('repo'), runner({ [Z]: old, [NL]: Buffer.from(porcelain(RECORDS, '\n')) }));
  assert.ok(nl.kind === 'ok' && nl.worktrees.length === 4);
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

test('pointsAtLinkedWorktree: worktree .git files, not submodules', () => {
  assert.ok(pointsAtLinkedWorktree('gitdir: /repo/.git/worktrees/feature\n'));
  assert.ok(pointsAtLinkedWorktree('gitdir: C:/Users/me/repo/.git/worktrees/fix-2\r\n'));
  assert.ok(!pointsAtLinkedWorktree('gitdir: ../../.git/modules/vendor/lib\n'));
  assert.ok(!pointsAtLinkedWorktree('gitdir: /repo/.git/worktrees\n'));
  assert.ok(!pointsAtLinkedWorktree('[core]\n\tbare = false\n'));
});

test('relativeInside: keeps the child path as written, not case-folded', () => {
  assert.equal(relativeInside(P('Repo'), P('Repo', '.worktrees', 'Fix-Bug')), '.worktrees/Fix-Bug');
});
