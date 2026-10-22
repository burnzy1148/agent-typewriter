import { test } from 'node:test';
import assert from 'node:assert/strict';
import { literalGlob, PathFilter, RootGlobs, selectionGlob, stillFiltered } from '../src/filter';

const only = (include: string[]) => new PathFilter({ include, exclude: [], extensions: [] });

test('literalGlob: a selected file or folder matches itself and nothing else', () => {
  // [selected path, a file under it when it is a folder, an unrelated path]
  const cases: Array<[string, string | undefined, string]> = [
    ['app/[id]/page.tsx', undefined, 'app/i/page.tsx'],
    ['app/[id]', 'app/[id]/page.tsx', 'app/d/page.tsx'],
    ['pages/[...slug].tsx', undefined, 'pages/s.tsx'],
    ['src/routes/[slug]', 'src/routes/[slug]/+page.svelte', 'src/routes/s/+page.svelte'],
    ['src/(group)/a.ts', undefined, 'src/group/a.ts'],
    ['x/@(y).ts', undefined, 'x/y.ts'],
    ['x/!(y)', 'x/!(y)/z.ts', 'x/q/z.ts'],
    ['a/b*?.ts', undefined, 'a/bX.ts'],
    ['a/b*?.ts', undefined, 'a/bxyz?.ts'],
    ['notes/{a,b}.md', undefined, 'notes/a.md'],
    ['notes/{a,b}', 'notes/{a,b}/c.md', 'notes/b/c.md'],
    ['a{1..3}.md', undefined, 'a1.md'],
    ['!important.ts', undefined, 'other.ts'],
    ['!dir', '!dir/x.ts', 'dir/x.ts'],
    ['#notes.md', undefined, 'notes.md'],
    ['src/a.ts', undefined, 'src/b.ts'],
    ['src/ notes.md ', undefined, 'src/notes.md'],
  ];
  for (const [selected, under, unrelated] of cases) {
    const isDir = under !== undefined;
    const f = only([selectionGlob(selected, isDir)]);
    assert.ok(f.matches(under ?? selected), `${selectionGlob(selected, isDir)} does not match ${under ?? selected}`);
    assert.ok(!f.matches(unrelated), `${selectionGlob(selected, isDir)} also matches ${unrelated}`);
  }
});

test('literalGlob: plain paths are written as before', () => {
  assert.equal(literalGlob('src/a.ts'), 'src/a.ts');
  assert.equal(selectionGlob('src/a.ts', false), 'src/a.ts');
  assert.equal(selectionGlob('src', true), 'src/**');
  assert.equal(literalGlob('src\\win\\a.ts'), 'src/win/a.ts');
});

test('selectionGlob: a workspace folder root covers every file, never an absolute path', () => {
  assert.equal(selectionGlob(undefined, true), '**/*');
  const f = only([selectionGlob(undefined, true)]);
  for (const p of ['src/a.ts', 'README.md', '.github/ci.yml']) assert.ok(f.matches(p), p);
});

test('PathFilter: real brace globs still expand', () => {
  const f = only(['{src,lib}/**']);
  assert.ok(f.matches('src/a.ts'));
  assert.ok(f.matches('lib/b.ts'));
  assert.ok(!f.matches('test/c.ts'));
});

test('PathFilter.blockedBy names the rule that rejects a path', () => {
  const f = new PathFilter({ include: ['src/**'], exclude: ['src/generated/**'], extensions: ['ts'] });
  assert.equal(f.blockedBy('src'), 'extension', 'a folder-like name has no extension');
  assert.equal(f.blockedBy('src/README.md'), 'extension');
  assert.equal(f.blockedBy('src/generated/a.ts'), 'exclude');
  assert.equal(f.blockedBy('lib/a.ts'), 'include');
  assert.equal(f.blockedBy('src/a.ts'), undefined);
  assert.equal(f.blockedBy('vendor/.git'), 'git');
  for (const p of ['src', 'src/README.md', 'src/generated/a.ts', 'lib/a.ts']) assert.ok(!f.matches(p), p);
  assert.ok(f.matches('src/a.ts'));
});

test('PathFilter: .git files are never recorded, whatever the settings', () => {
  for (const exclude of [['**/.git/**'], [], ['dist/**']]) {
    const f = new PathFilter({ include: ['**/*'], exclude, extensions: [] });
    for (const p of ['.git', 'vendor/lib/.git', 'a/b/.GIT', 'side\\.git']) assert.ok(!f.matches(p), `${p} with exclude ${exclude}`);
    for (const p of ['.gitignore', '.gitmodules', 'src/.git-hooks.ts', 'foo.git', '.github/ci.yml']) assert.ok(f.matches(p), `${p} with exclude ${exclude}`);
  }
  // Directory pruning is unchanged: only .git directories are pruned, by the default exclude.
  assert.ok(new PathFilter({ include: [], exclude: ['**/.git/**'], extensions: [] }).excludesDir('.git'));
  assert.ok(!new PathFilter({ include: [], exclude: [], extensions: [] }).excludesDir('.git'));
});

test('PathFilter.excludesDir: negated globs never prune a directory holding recorded files', () => {
  assert.ok(!new PathFilter({ include: [], exclude: ['!src/**'], extensions: [] }).excludesDir('src'));
  assert.ok(!new PathFilter({ include: [], exclude: ['!src/**'], extensions: [] }).excludesDir('src/sub'));
  const keep = new PathFilter({ include: [], exclude: ['!**/keep/**'], extensions: [] });
  for (const d of ['lib', 'lib/keep', 'lib/keep/deep']) assert.ok(!keep.excludesDir(d), d);
  const mixed = new PathFilter({ include: [], exclude: ['**/node_modules/**', '!src/**'], extensions: [] });
  assert.ok(mixed.excludesDir('node_modules'), 'a plain exclude still prunes');

  // Invariant: no file under a pruned directory passes matches().
  const files = ['src/a.ts', 'src/sub/b.ts', 'lib/keep/c.ts', 'lib/keep/deep/d.ts', 'lib/e.ts', 'node_modules/m/i.js', 'top/t.ts', 'x/top/u.ts'];
  const dirsOf = (f: string) => f.split('/').slice(0, -1).map((_, i, parts) => parts.slice(0, i + 1).join('/'));
  for (const exclude of [['!src/**'], ['!**/keep/**'], ['**/node_modules/**', '!src/**'], ['top/**', '**/node_modules/**'], ['!(foo)/**']]) {
    const f = new PathFilter({ include: [], exclude, extensions: [] });
    for (const file of files) {
      if (!f.matches(file)) continue;
      for (const dir of dirsOf(file)) assert.ok(!f.excludesDir(dir), `${exclude}: pruned ${dir} though ${file} is recorded`);
    }
  }
});

test('stillFiltered: folders never warn; files name the rule a selection cannot override', () => {
  const f = new PathFilter({ include: ['src/**'], exclude: ['src/generated/**'], extensions: ['ts', 'tsx'] });
  assert.equal(stillFiltered(f, [{ rel: 'src', isFile: false }]), undefined, 'a folder was checked as a file');
  assert.equal(stillFiltered(f, [{ rel: 'src/a.ts', isFile: true }]), undefined);
  assert.deepEqual(stillFiltered(f, [{ rel: 'README.md', isFile: true }]), { rel: 'README.md', by: 'extension' });
  assert.deepEqual(stillFiltered(f, [{ rel: 'src/generated/a.ts', isFile: true }]), { rel: 'src/generated/a.ts', by: 'exclude' });
  // Only the include rejects it, and the selection just set the include.
  assert.equal(stillFiltered(f, [{ rel: 'lib/a.ts', isFile: true }]), undefined);
  assert.deepEqual(
    stillFiltered(f, [
      { rel: 'docs', isFile: false },
      { rel: 'src/a.ts', isFile: true },
      { rel: 'notes.md', isFile: true },
    ]),
    { rel: 'notes.md', by: 'extension' },
  );
});

test('RootGlobs: globs match from the root, and a covered directory covers what is under it', () => {
  const g = new RootGlobs(['build', '*.js', '**/wx/**', 'out/gen', '!keep/**', '/abs']);
  assert.ok(g.covers('build') && g.covers('build/a/b.ts'));
  assert.ok(!g.covers('src/build/gen.ts'), 'a slashless glob names a path at the root, not a name anywhere');
  assert.ok(g.covers('a.js') && !g.covers('src/a.js'));
  assert.ok(g.covers('wx/w.ts') && g.covers('a/b/wx/w.ts') && !g.covers('wxy/w.ts'));
  assert.ok(g.covers('out/gen/x.ts') && !g.covers('out/x.ts'));
  assert.ok(!g.covers('keep/x.ts') && !g.covers('other.ts'), 'negated globs are ignored');
  assert.ok(g.covers('abs/x.ts'), 'a leading slash anchors at the root');
  assert.equal(new RootGlobs(['!x', '  ']).size, 0);
});
