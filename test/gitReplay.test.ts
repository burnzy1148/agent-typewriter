import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  buildReplay,
  countCommits,
  currentBranch,
  defaultBase,
  gitReason,
  GitReplayError,
  isRepository,
  listBranches,
  parseCommits,
  parseDiffTree,
  resolveRange,
} from '../src/gitReplay';
import { git, noGit, tempDir, tempRepo, write } from './gitFixture';

const SHA_A = 'a'.repeat(40);
const SHA_B = 'b'.repeat(40);
const ZERO = '0'.repeat(40);

test('resolveRange: a lone plain revision is that one commit', () => {
  assert.deepEqual(resolveRange('abc123'), ['abc123^!']);
  assert.deepEqual(resolveRange(' HEAD~2 '), ['HEAD~2^!']);
  assert.deepEqual(resolveRange('HEAD^'), ['HEAD^^!']);
});

test('resolveRange: ranges and multiple revisions pass through', () => {
  assert.deepEqual(resolveRange('main..feature'), ['main..feature']);
  assert.deepEqual(resolveRange('main...feature'), ['main...feature']);
  assert.deepEqual(resolveRange('abc^!'), ['abc^!']);
  assert.deepEqual(resolveRange('abc^@'), ['abc^@']);
  assert.deepEqual(resolveRange('feature ^main'), ['feature', '^main']);
});

test('resolveRange: refuses empty input and options', () => {
  assert.throws(() => resolveRange('  '), GitReplayError);
  assert.throws(() => resolveRange('--all'), /"--all" is not a revision/);
  assert.throws(() => resolveRange('main..x -p'), GitReplayError);
});

test('parseCommits: header and formatted line pairs, subjects with spaces', () => {
  const out = `commit ${SHA_A}\n${SHA_A} 1700000000 Add a thing\ncommit ${SHA_B}\n${SHA_B} 1700000060 commit ${SHA_A} again\n`;
  assert.deepEqual(parseCommits(out), [
    { sha: SHA_A, time: 1700000000000, subject: 'Add a thing' },
    { sha: SHA_B, time: 1700000060000, subject: `commit ${SHA_A} again` },
  ]);
  assert.deepEqual(parseCommits(`commit ${SHA_A}\n${SHA_A} 1700000000\n`), [{ sha: SHA_A, time: 1700000000000, subject: '' }]);
  assert.deepEqual(parseCommits(''), []);
  // `.` alone does not match a bare CR or a Unicode line separator.
  assert.deepEqual(
    parseCommits(`commit ${SHA_A}\n${SHA_A} 1700000000 ls\u2028here\rand\u2029there\n`).map((c) => c.subject),
    ['ls\u2028here\rand\u2029there'],
  );
});

test('parseDiffTree: kinds from the regular-file sides, others skipped', () => {
  const rec = (oldMode: string, newMode: string, oldSha: string, newSha: string, status: string, p: string) =>
    `:${oldMode} ${newMode} ${oldSha} ${newSha} ${status}\0${p}\0`;
  const out =
    rec('000000', '100644', ZERO, SHA_A, 'A', 'new file.ts') +
    rec('100644', '100755', SHA_A, SHA_B, 'M', 'src/run.sh') +
    rec('100644', '000000', SHA_A, ZERO, 'D', 'gone.ts') +
    rec('120000', '100644', SHA_A, SHA_B, 'T', 'was-link') +
    rec('100644', '120000', SHA_A, SHA_B, 'T', 'now-link') +
    rec('000000', '160000', ZERO, SHA_A, 'A', 'vendor/sub') +
    rec('120000', '120000', SHA_A, SHA_B, 'M', 'link');
  assert.deepEqual(parseDiffTree(out), [
    { path: 'new file.ts', kind: 'create', afterSha: SHA_A },
    { path: 'src/run.sh', kind: 'modify', beforeSha: SHA_A, afterSha: SHA_B },
    { path: 'gone.ts', kind: 'delete', beforeSha: SHA_A },
    { path: 'was-link', kind: 'create', afterSha: SHA_B },
    { path: 'now-link', kind: 'delete', beforeSha: SHA_A },
  ]);
});

test('parseDiffTree: a rename has the old path, then the new; a non-regular side makes it a create or delete', () => {
  const rec = (oldMode: string, newMode: string, status: string, from: string, to: string) => `:${oldMode} ${newMode} ${SHA_A} ${SHA_B} ${status}\0${from}\0${to}\0`;
  const out = rec('100644', '100644', 'R100', 'src/a.ts', 'lib/a.ts') + rec('120000', '100644', 'R090', 'link', 'file') + rec('100644', '120000', 'R090', 'file2', 'link2');
  assert.deepEqual(parseDiffTree(out), [
    { path: 'lib/a.ts', fromPath: 'src/a.ts', kind: 'rename', beforeSha: SHA_A, afterSha: SHA_B },
    { path: 'file', kind: 'create', afterSha: SHA_B },
    { path: 'file2', kind: 'delete', beforeSha: SHA_A },
  ]);
});

test('gitReason: git fatal lines without the command line', () => {
  const err = new Error("Command failed: git --no-optional-locks rev-list nope --\nfatal: bad revision 'nope'\n");
  assert.equal(gitReason(err), "bad revision 'nope'");
  assert.equal(gitReason(new Error('spawn git ENOENT')), 'spawn git ENOENT');
});

/** A repository whose `feature` branch has three commits on `main`, plus a merge of main. */
function featureRepo(): string {
  const repo = tempRepo('at-replay-');
  write(repo, 'src/a.ts', 'export const a = 1;\n');
  write(repo, 'src/gone.ts', 'export const gone = true;\n');
  write(repo, 'README.md', '# repo\n');
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', 'initial');
  git(repo, 'checkout', '-q', '-b', 'feature');
  write(repo, 'src/a.ts', 'export const a = 2;\n');
  write(repo, 'src/b.ts', 'export const b = 1;\n');
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', 'Change a, add b');
  // Main moves on and is merged into the feature branch.
  git(repo, 'checkout', '-q', 'main');
  write(repo, 'README.md', '# repo\n\nMore.\n');
  git(repo, 'commit', '-q', '-am', 'Main: readme');
  git(repo, 'checkout', '-q', 'feature');
  git(repo, 'merge', '-q', '--no-edit', 'main');
  write(repo, 'src/a.ts', 'export const a = 3;\nexport const twice = a * 2;\n');
  fs.rmSync(path.join(repo, 'src/gone.ts'));
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', 'Change a again, remove gone');
  return repo;
}

test('buildReplay: a branch range, oldest first, merges skipped', { skip: noGit }, async () => {
  const repo = featureRepo();
  const r = await buildReplay(repo, resolveRange('main..feature'), { uriOf: (p) => `file:///ws/${p}` });
  assert.deepEqual(
    r.commits.map((c) => c.subject),
    ['Change a, add b', 'Change a again, remove gone'],
  );
  assert.deepEqual(
    r.events.map((e) => [e.kind, e.relPath, e.before, e.after]),
    [
      ['modify', 'src/a.ts', 'export const a = 1;\n', 'export const a = 2;\n'],
      ['create', 'src/b.ts', '', 'export const b = 1;\n'],
      ['modify', 'src/a.ts', 'export const a = 2;\n', 'export const a = 3;\nexport const twice = a * 2;\n'],
      ['delete', 'src/gone.ts', 'export const gone = true;\n', ''],
    ],
  );
  const [first, , third] = r.events;
  assert.equal(first.uri, 'file:///ws/src/a.ts');
  assert.equal(first.time, r.commits[0].time);
  assert.deepEqual([third.linesAdded, third.linesRemoved], [2, 1]);
  assert.deepEqual(r.commitOf.map((c) => c.subject), ['Change a, add b', 'Change a, add b', 'Change a again, remove gone', 'Change a again, remove gone']);
  assert.equal(await countCommits(repo, ['main..feature']), 2);
});

test('buildReplay: text comes from history, not the working tree; the repository is untouched', { skip: noGit }, async () => {
  const repo = featureRepo();
  write(repo, 'src/a.ts', 'uncommitted\n');
  write(repo, 'staged.ts', 'staged\n');
  git(repo, 'add', 'staged.ts');
  const head = git(repo, 'rev-parse', 'HEAD');
  const status = git(repo, '--no-optional-locks', 'status', '--porcelain=v1', '-z');
  const refs = git(repo, 'for-each-ref');
  const index = fs.readFileSync(path.join(repo, '.git', 'index'));
  const r = await buildReplay(repo, resolveRange('main..feature'));
  assert.equal(r.events[2].after, 'export const a = 3;\nexport const twice = a * 2;\n');
  assert.equal(git(repo, 'rev-parse', 'HEAD'), head);
  assert.equal(git(repo, '--no-optional-locks', 'status', '--porcelain=v1', '-z'), status);
  assert.equal(git(repo, 'for-each-ref'), refs);
  assert.deepEqual(fs.readFileSync(path.join(repo, '.git', 'index')), index);
  assert.equal(fs.readFileSync(path.join(repo, 'src/a.ts'), 'utf8'), 'uncommitted\n');
});

test('buildReplay: a single commit, and the root commit as creates', { skip: noGit }, async () => {
  const repo = featureRepo();
  const one = await buildReplay(repo, resolveRange('feature~1'));
  // feature~1 is the merge; its first parent's branch commit is feature~2.
  assert.deepEqual(one.events, []);
  const single = await buildReplay(repo, resolveRange('feature~2'));
  assert.deepEqual(single.events.map((e) => [e.kind, e.relPath]), [['modify', 'src/a.ts'], ['create', 'src/b.ts']]);
  const root = git(repo, 'rev-list', '--max-parents=0', 'HEAD').trim();
  const initial = await buildReplay(repo, resolveRange(root));
  assert.deepEqual(initial.events.map((e) => [e.kind, e.relPath]), [['create', 'README.md'], ['create', 'src/a.ts'], ['create', 'src/gone.ts']]);
});

test('buildReplay: a folder below the repository top sees only its files, relative to it', { skip: noGit }, async () => {
  const repo = tempRepo('at-replay-sub-');
  write(repo, 'pkg/src/a.ts', 'one\n');
  write(repo, 'README.md', 'top\n');
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', 'initial');
  write(repo, 'pkg/src/a.ts', 'two\n');
  write(repo, 'README.md', 'top 2\n');
  git(repo, 'commit', '-q', '-am', 'both');
  const r = await buildReplay(path.join(repo, 'pkg'), resolveRange('HEAD~1..HEAD'));
  assert.deepEqual(r.events.map((e) => [e.relPath, e.before, e.after]), [['src/a.ts', 'one\n', 'two\n']]);
});

test('buildReplay: filtered, binary, oversized, symlink and mode-only changes are skipped', { skip: noGit }, async () => {
  const repo = tempRepo('at-replay-skip-');
  write(repo, 'keep.ts', 'a\n');
  write(repo, 'tool.sh', 'echo hi\n');
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', 'initial');
  write(repo, 'keep.ts', 'b\n');
  write(repo, 'notes.txt', 'filtered\n');
  fs.writeFileSync(path.join(repo, 'image.ts'), Buffer.from([0x89, 0x50, 0x00, 0x01]));
  write(repo, 'big.ts', 'x'.repeat(2000));
  git(repo, 'add', '-A');
  git(repo, 'update-index', '--chmod=+x', 'tool.sh');
  // A symlink, added straight to the index so it works where symlinks don't.
  const blob = git(repo, 'rev-parse', ':keep.ts').trim();
  git(repo, 'update-index', '--add', '--cacheinfo', `120000,${blob},link`);
  git(repo, 'commit', '-q', '-m', 'many');
  const r = await buildReplay(repo, resolveRange('HEAD'), { filter: (p) => !p.endsWith('.txt'), maxBytes: 1000 });
  assert.deepEqual(r.events.map((e) => [e.relPath, e.after]), [['keep.ts', 'b\n']]);
  assert.deepEqual(r.skipped, { filtered: 1, binary: 1, tooLarge: 1, unreadable: 0, lfs: 0, shallow: 0 });
});

test('buildReplay: CRLF text is normalized and keeps its line ending', { skip: noGit }, async () => {
  const repo = tempRepo('at-replay-eol-');
  write(repo, 'win.ts', 'one\r\n');
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', 'initial');
  write(repo, 'win.ts', 'one\r\ntwo\r\n');
  git(repo, 'commit', '-q', '-am', 'two');
  const [e] = (await buildReplay(repo, resolveRange('HEAD'))).events;
  assert.deepEqual([e.before, e.after, e.eol], ['one\n', 'one\ntwo\n', '\r\n']);
});

test('buildReplay: an unknown revision fails with git reason; cancelling stops it', { skip: noGit }, async () => {
  const repo = featureRepo();
  await assert.rejects(buildReplay(repo, resolveRange('main..nope')), (err: Error) => err instanceof GitReplayError && /nope/.test(err.message));
  await assert.rejects(buildReplay(repo, resolveRange('main..feature'), { isCancelled: () => true }), /Cancelled/);
  // A range within one batch still notices a cancel that comes while it reads.
  let checks = 0;
  await assert.rejects(buildReplay(repo, resolveRange('main..feature'), { isCancelled: () => ++checks > 2 }), /Cancelled/);
});

test('buildReplay: mirror paths come from mirrorPathOf, filters see the folder-relative path', { skip: noGit }, async () => {
  const repo = featureRepo();
  const seen: string[] = [];
  const r = await buildReplay(repo, resolveRange('main..feature'), {
    filter: (p) => (seen.push(p), true),
    mirrorPathOf: (p) => `app/${p}`,
  });
  assert.deepEqual(r.events.map((e) => e.relPath), ['app/src/a.ts', 'app/src/b.ts', 'app/src/a.ts', 'app/src/gone.ts']);
  assert.ok(seen.every((p) => !p.startsWith('app/')), seen.join());
});

test('buildReplay: git renames are renames; one side filtered makes a create or a delete', { skip: noGit }, async () => {
  const repo = tempRepo('at-replay-ren-');
  const ten = Array.from({ length: 10 }, (_, i) => `export const v${i} = ${i};\n`).join('');
  write(repo, 'src/a.ts', ten);
  write(repo, 'src/b.ts', 'export const b = 1;\n');
  write(repo, 'notes.txt', 'some notes\nmore notes\n');
  write(repo, 'src/out.ts', 'export const out = 1;\nexport const out2 = 2;\n');
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', 'initial');
  fs.mkdirSync(path.join(repo, 'lib'));
  git(repo, 'mv', 'src/a.ts', 'lib/a.ts');
  git(repo, 'mv', 'src/b.ts', 'lib/b.ts');
  write(repo, 'lib/b.ts', 'export const b = 1;\n');
  git(repo, 'mv', 'notes.txt', 'notes.ts');
  git(repo, 'mv', 'src/out.ts', 'src/out.txt');
  write(repo, 'lib/a.ts', ten.replace('v3 = 3', 'v3 = 33'));
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', 'Move things');
  const r = await buildReplay(repo, resolveRange('HEAD'), { filter: (p) => p.endsWith('.ts'), uriOf: (p) => `file:///ws/${p}` });
  const shown = r.events.map((e) => [e.kind, e.fromRelPath ?? '', e.relPath]).sort((x, y) => x[2].localeCompare(y[2]));
  assert.deepEqual(shown, [
    ['rename', 'src/a.ts', 'lib/a.ts'],
    ['rename', 'src/b.ts', 'lib/b.ts'],
    ['create', '', 'notes.ts'],
    ['delete', '', 'src/out.ts'],
  ]);
  const a = r.events.find((e) => e.relPath === 'lib/a.ts')!;
  assert.deepEqual([a.before, a.after, a.fromUri, a.linesAdded, a.linesRemoved], [ten, ten.replace('v3 = 3', 'v3 = 33'), 'file:///ws/src/a.ts', 1, 1]);
  const b = r.events.find((e) => e.relPath === 'lib/b.ts')!;
  assert.equal(b.before, b.after, 'a pure rename is kept');
});

test('buildReplay: a Git LFS pointer is skipped, not typed', { skip: noGit }, async () => {
  const repo = tempRepo('at-replay-lfs-');
  write(repo, 'model.ts', `version https://git-lfs.github.com/spec/v1\noid sha256:${'a'.repeat(64)}\nsize 12345\n`);
  write(repo, 'docs.md', 'version https://git-lfs.github.com/spec/v1 is a pointer format\n');
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', 'pointer');
  const r = await buildReplay(repo, resolveRange('HEAD'));
  assert.deepEqual(r.events.map((e) => e.relPath), ['docs.md']);
  assert.equal(r.skipped.lfs, 1);
});

test('buildReplay: a shallow clone boundary commit is skipped, not replayed as every file created', { skip: noGit }, async () => {
  const repo = featureRepo();
  const shallow = path.join(tempDir('at-replay-shallow-'), 's');
  git(path.dirname(shallow), 'clone', '-q', '--depth', '2', '--branch', 'feature', `file://${repo.replace(/\\/g, '/')}`, shallow);
  const r = await buildReplay(shallow, resolveRange('HEAD~1..HEAD'));
  assert.deepEqual(r.events.map((e) => [e.kind, e.relPath]), [['modify', 'src/a.ts'], ['delete', 'src/gone.ts']]);
  const all = await buildReplay(shallow, resolveRange('HEAD'));
  assert.equal(all.events.length, 2);
  const boundary = await buildReplay(shallow, ['HEAD~1']);
  assert.ok(boundary.skipped.shallow >= 1, 'the boundary commit was replayed');
  assert.ok(!boundary.events.some((e) => e.relPath === 'README.md'), 'the boundary commit replayed every file as created');
});

/** git 2.44 added GIT_NO_LAZY_FETCH. */
const noLazyFetch: string | undefined = (() => {
  if (noGit) return noGit;
  const m = /(\d+)\.(\d+)/.exec(git(os.tmpdir(), '--version'));
  return m && (Number(m[1]) > 2 || (Number(m[1]) === 2 && Number(m[2]) >= 44)) ? undefined : 'git older than 2.44';
})();

test('buildReplay: a partial clone fetches nothing; missing blobs are unreadable', { skip: noLazyFetch }, async () => {
  const repo = featureRepo();
  git(repo, 'config', 'uploadpack.allowFilter', 'true');
  const partial = path.join(tempDir('at-replay-partial-'), 'p');
  git(path.dirname(partial), 'clone', '-q', '--filter=blob:none', '--no-checkout', `file://${repo.replace(/\\/g, '/')}`, partial);
  const objects = () => fs.readdirSync(path.join(partial, '.git', 'objects', 'pack')).sort();
  const before = objects();
  const r = await buildReplay(partial, resolveRange('origin/main..origin/feature'));
  assert.deepEqual(objects(), before, 'reading history fetched objects');
  assert.equal(r.events.length, 0);
  assert.ok(r.skipped.unreadable > 0);
});

test('defaultBase: the remote default branch, else the usual names', { skip: noGit }, async () => {
  const repo = featureRepo();
  assert.deepEqual(await defaultBase(repo), { ref: 'refs/heads/main', name: 'main' });
  const clone = path.join(tempDir('at-replay-clone-'), 'c');
  git(path.dirname(clone), 'clone', '-q', repo, clone);
  git(clone, 'branch', '-q', 'develop', 'origin/main');
  git(clone, 'update-ref', 'refs/remotes/origin/develop', 'origin/main');
  git(clone, 'symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/develop');
  assert.deepEqual(await defaultBase(clone), { ref: 'refs/remotes/origin/develop', name: 'origin/develop' });
  const bare = tempRepo('at-replay-none-');
  assert.equal(await defaultBase(bare), undefined);
});

test('listBranches, currentBranch and isRepository', { skip: noGit }, async () => {
  const repo = featureRepo();
  const clone = path.join(tempDir('at-replay-clone-'), 'c');
  git(path.dirname(clone), 'clone', '-q', repo, clone);
  // A tag named like a branch does not shadow it: branches carry their full ref.
  git(clone, 'tag', 'feature', 'origin/main');
  const listed = await listBranches(clone);
  const names = listed.map((b) => b.name);
  assert.ok(names.includes('feature') && names.includes('origin/main') && names.includes('origin/feature'), names.join());
  assert.ok(!names.some((b) => b === 'origin' || b.endsWith('/HEAD')), names.join());
  assert.deepEqual(listed.find((b) => b.name === 'origin/feature'), { ref: 'refs/remotes/origin/feature', name: 'origin/feature' });
  const viaRef = await buildReplay(clone, [`refs/remotes/origin/main..refs/heads/feature`]);
  assert.equal(viaRef.commits.length, 2);
  assert.equal(await currentBranch(repo), 'feature');
  git(repo, 'checkout', '-q', '--detach');
  assert.equal(await currentBranch(repo), undefined);
  assert.equal(await isRepository(repo), true);
  assert.equal(await isRepository(tempDir('at-replay-plain-')), false);
});
