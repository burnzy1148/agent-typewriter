import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Timeline, type NewChangeEvent } from '../src/timeline';
import { PathFilter, toSlashes, parseExtensionList } from '../src/filter';

function ev(relPath: string, before: string, after: string): NewChangeEvent {
  return { uri: 'file:///w/' + relPath, relPath, time: Date.now(), kind: 'modify', before, after, eol: '\n', linesAdded: 0, linesRemoved: 0 };
}

test('events play back in recorded order across files', () => {
  const t = new Timeline(100);
  t.push(ev('a.ts', '', 'a1'));
  t.push(ev('b.ts', '', 'b1'));
  t.push(ev('a.ts', 'a1', 'a2'));
  const order: string[] = [];
  for (let e = t.peek(); e; e = t.peek()) {
    t.begin(e.seq);
    order.push(`${e.relPath}:${e.after}`);
    t.complete(e.seq);
  }
  assert.deepEqual(order, ['a.ts:a1', 'b.ts:b1', 'a.ts:a2']);
  assert.equal(t.pendingCount(), 0);
});

test('pending excludes the event being typed', () => {
  const t = new Timeline(100);
  const a = t.push(ev('a', '', '1'));
  t.push(ev('b', '', '1'));
  t.begin(a.seq);
  assert.equal(t.pendingCount(), 1);
});

test('seek replays from an earlier point', () => {
  const t = new Timeline(100);
  const first = t.push(ev('a', '', '1'));
  const second = t.push(ev('a', '1', '2'));
  t.seekToEnd();
  assert.equal(t.peek(), undefined);
  t.seek(first.seq);
  assert.equal(t.peek()?.seq, first.seq);
  t.complete(first.seq);
  assert.equal(t.peek()?.seq, second.seq);
});

test('overflow drops oldest and keeps cursor valid', () => {
  const t = new Timeline(3);
  for (let i = 0; i < 5; i++) t.push(ev('f', String(i), String(i + 1)));
  assert.equal(t.all().length, 3);
  assert.equal(t.peek()?.before, '2');
  assert.equal(t.droppedUnplayed, 2);
});

test('latestStates keeps the newest event per file', () => {
  const t = new Timeline(10);
  t.push(ev('a', '', '1'));
  t.push(ev('b', '', 'x'));
  t.push(ev('a', '1', '2'));
  const s = t.latestStates();
  assert.equal(s.get('a')?.after, '2');
  assert.equal(s.get('b')?.after, 'x');
});

test('mirrorStates shows the newest played after text, else the earliest before text', () => {
  const t = new Timeline(10);
  assert.equal(t.mirrorStates().size, 0);
  const a1 = t.push(ev('a', '', '1'));
  t.push(ev('b', 'b0', 'b1'));
  t.push(ev('b', 'b1', 'b2'));
  const c = t.push({ ...ev('c', 'c0', 'c1'), eol: '\r\n' });
  t.push(ev('a', '1', '2'));
  t.push(ev('a', '2', '3'));
  t.push({ ...ev('d', 'gone', ''), kind: 'delete' });
  // Only a's first change played: b shows its earliest before text.
  t.seek(a1.seq + 1);
  assert.deepEqual(t.mirrorStates().get('a'), { text: '1', eol: '\n' });
  assert.deepEqual(t.mirrorStates().get('b'), { text: 'b0', eol: '\n' });
  t.seekToEnd();
  const s = t.mirrorStates();
  assert.deepEqual(s.get('a'), { text: '3', eol: '\n' });
  assert.deepEqual(s.get('b'), { text: 'b2', eol: '\n' });
  assert.deepEqual(s.get('c'), { text: 'c1', eol: '\r\n' });
  assert.deepEqual(s.get('d'), { text: '', eol: '\n' });
  // Played and queued changes to one file: the newest played after text wins.
  t.seek(c.seq + 1);
  assert.deepEqual(t.mirrorStates().get('a'), { text: '1', eol: '\n' });
  assert.deepEqual(t.mirrorStates().get('c'), { text: 'c1', eol: '\r\n' });
  assert.deepEqual(t.mirrorStates().get('d'), { text: 'gone', eol: '\n' });
});

function rename(from: string, to: string, before: string, after: string): NewChangeEvent {
  return { ...ev(to, before, after), kind: 'rename', fromUri: 'file:///w/' + from, fromRelPath: from };
}

test('latestStates drops a path renamed away, unless it changes again', () => {
  const t = new Timeline(10);
  t.push(ev('a', '', '1'));
  t.push(rename('a', 'b', '1', '1'));
  assert.deepEqual([...t.latestStates().keys()], ['b']);
  t.push(ev('a', '', 'again'));
  assert.equal(t.latestStates().get('a')?.after, 'again');
});

test('mirrorStates: a played rename leaves no old mirror, a queued one no new mirror yet', () => {
  const t = new Timeline(10);
  const a = t.push(ev('a', '', '1'));
  const r = t.push(rename('a', 'b', '1', '2'));
  t.push(ev('b', '2', '3'));
  t.seek(r.seq);
  assert.deepEqual([...t.mirrorStates()], [['a', { text: '1', eol: '\n' }]]);
  t.seek(a.seq);
  assert.deepEqual([...t.mirrorStates()], [['a', { text: '', eol: '\n' }]]);
  t.seek(r.seq + 1);
  assert.deepEqual([...t.mirrorStates()], [['b', { text: '2', eol: '\n' }]]);
  t.seekToEnd();
  assert.deepEqual([...t.mirrorStates()], [['b', { text: '3', eol: '\n' }]]);
  // A file created again at the old path after the played rename gets its own mirror.
  const again = t.push(ev('a', '', 'new a'));
  assert.deepEqual(t.mirrorStates().get('a'), undefined);
  t.complete(again.seq);
  assert.deepEqual(t.mirrorStates().get('a'), { text: 'new a', eol: '\n' });
});

test('filter: extension allow-list', () => {
  const f = new PathFilter({ include: ['**/*'], exclude: [], extensions: ['ts', '.Java'] });
  assert.ok(f.matches('src/a.ts'));
  assert.ok(f.matches('src/B.java'));
  assert.ok(!f.matches('README.md'));
  assert.ok(!f.matches('Makefile'));
});

test('filter: exclude beats include, slashless globs match anywhere', () => {
  const f = new PathFilter({ include: ['*.ts', 'docs/**'], exclude: ['**/node_modules/**', '**/*.spec.ts'], extensions: [] });
  assert.ok(f.matches('deep/dir/x.ts'));
  assert.ok(f.matches('docs/guide.md'));
  assert.ok(!f.matches('x.spec.ts'));
  assert.ok(!f.matches('node_modules/pkg/i.ts'));
  assert.ok(!f.matches('src/a.js'));
});

test('filter: dotfiles and windows separators', () => {
  const f = new PathFilter({ include: ['**/*'], exclude: ['**/.git/**'], extensions: [] });
  assert.ok(f.matches('.github/workflows/ci.yml'));
  assert.ok(f.matches('src\\win\\path.ts'));
  assert.ok(!f.matches('.git/HEAD'));
  if (process.platform === 'win32') assert.ok(!f.matches('.git\\HEAD'), 'a backslash is a separator on Windows');
});

test('toSlashes: a backslash is a separator only on Windows', () => {
  assert.equal(toSlashes('src\\win\\path.ts', 'win32'), 'src/win/path.ts');
  assert.equal(toSlashes('src\\a.ts', 'linux'), 'src\\a.ts');
  assert.equal(toSlashes('src\\a.ts', 'darwin'), 'src\\a.ts');
  assert.equal(toSlashes('src/a.ts', 'linux'), 'src/a.ts');
});

test('filter: a backslash in a POSIX file name is not a directory separator', () => {
  const f = new PathFilter({ include: ['src/**'], exclude: ['gen/out/**'], extensions: [] });
  // A root-level file named `src\a.ts`, and a root-level directory named `gen\out`.
  if (process.platform === 'win32') {
    assert.ok(f.matches('src\\a.ts'));
    assert.ok(f.excludesDir('gen\\out'));
  } else {
    assert.ok(!f.matches('src\\a.ts'), 'src/** admitted a root-level file');
    assert.ok(f.matches('src/a.ts'));
    assert.ok(!f.excludesDir('gen\\out'), 'a directory named gen\\out was taken for gen/out');
    assert.ok(f.excludesDir('gen/out'));
  }
});

test('parseExtensionList accepts loose input', () => {
  assert.deepEqual(parseExtensionList(' .ts, java  *.MD;py '), ['ts', 'java', 'md', 'py']);
});

test('PathFilter.excludesDir: only globs that cover the whole directory prune it', () => {
  const f = new PathFilter({ include: ['src/**'], exclude: ['**/node_modules/**', '**/dist/**', '*.log', 'src/**/*.gen.ts'], extensions: ['ts'] });
  assert.ok(f.excludesDir('node_modules'));
  assert.ok(f.excludesDir('packages/app/node_modules/'));
  assert.ok(f.excludesDir('dist'));
  assert.ok(!f.excludesDir('src'), 'include and extensions never prune');
  assert.ok(!f.excludesDir('logs'), 'a file-name glob does not prune a directory');
  assert.ok(!f.excludesDir('src/gen'), 'a glob for some files in a directory does not prune it');
  const g = new PathFilter({ include: [], exclude: ['foo/*', '**/a/*', '?', 'src/!(*.ts)', 'top/**'], extensions: [] });
  for (const dir of ['foo', 'x/a', 'x', 'src']) assert.ok(!g.excludesDir(dir), `${dir} still holds recordable files`);
  assert.ok(g.excludesDir('top'));
  assert.ok(!g.excludesDir('nested/top'), 'a slashed glob matches from the root only');
});

test('PathFilter: malformed, braced, comma and directory-name excludes neither throw nor prune what they do not cover', () => {
  const f = new PathFilter({ include: [], exclude: ['**/node_modules/**', 'dist/**', '**/*.{log', '**/*.{log,tmp}', '**/[z-a].ts', '**/notes,old.md', '**/notes', '*.log', 'a\\b/**'], extensions: [] });
  assert.ok(f.excludesDir('node_modules') && f.excludesDir('dist'));
  for (const dir of ['docs/notes', 'notes', 'src']) assert.ok(!f.excludesDir(dir), `${dir} pruned`);
  assert.ok(!new PathFilter({ include: [], exclude: ['!foo/**'], extensions: [] }).excludesDir('foo'));
  for (const rel of ['src/app.ts', 'docs/notes/todo.md', 'docs/notes,old.md/x.ts', 'z.ts']) assert.ok(f.matches(rel), `${rel} rejected`);
  for (const rel of ['app.log', 'src/x.tmp', 'node_modules/p/i.js', 'docs/notes']) assert.ok(!f.matches(rel), `${rel} accepted`);
});

// Skip to next picks the playing change's seq + 1, or cursor + 1 when nothing plays (extension.ts).
function skipTarget(t: Timeline): number {
  return (t.all().find((e) => t.stateOf(e.seq) === 'playing')?.seq ?? t.cursor) + 1;
}

test('a seek back while a change is playing overtakes it', () => {
  const t = new Timeline(100);
  for (let i = 0; i < 8; i++) t.push(ev(`f${i}`, '', String(i)));
  t.seek(5);
  const token = t.begin(5);
  t.seek(2);
  assert.equal(t.stateOf(5), 'pending');
  assert.ok(!t.all().some((e) => t.stateOf(e.seq) === 'playing'));
  assert.equal(skipTarget(t), 3);
  t.complete(5, token);
  assert.equal(t.cursor, 2);
  assert.equal(t.stateOf(2), 'pending');
});

test('two quick skips while a change is playing skip two changes', () => {
  const t = new Timeline(100);
  for (let i = 0; i < 8; i++) t.push(ev(`f${i}`, '', String(i)));
  t.seek(5);
  t.begin(5);
  t.seek(skipTarget(t));
  assert.equal(t.cursor, 6);
  assert.equal(skipTarget(t), 7);
});

test('seekToEnd while a change is playing leaves nothing playing or queued', () => {
  const t = new Timeline(100);
  for (let i = 0; i < 8; i++) t.push(ev(`f${i}`, '', String(i)));
  t.seek(5);
  const token = t.begin(5);
  t.seekToEnd();
  assert.ok(!t.all().some((e) => t.stateOf(e.seq) === 'playing'));
  assert.equal(t.pendingCount(), 0);
  t.complete(5, token);
  assert.equal(t.pendingCount(), 0);
});

// ------------------------------------------------------------------ highlight clears

function played(n: number): Timeline {
  const t = new Timeline(100);
  for (let i = 0; i < n; i++) t.push(ev('a', String(i), String(i + 1)));
  t.seekToEnd();
  return t;
}

test('clearing highlights records the cursor, for all files or one, oldest first', () => {
  const t = played(3);
  t.clearHighlights('a');
  t.clearHighlights();
  assert.deepEqual(t.highlightClears, [{ seq: 4, relPath: 'a' }, { seq: 4 }]);
});

test('a clear while a change is typed counts that change as baseline', () => {
  const t = played(2);
  t.seek(2);
  t.begin(2);
  t.clearHighlights();
  assert.deepEqual(t.highlightClears, [{ seq: 3 }]);
  t.complete(2);
  assert.deepEqual(t.highlightClears, [{ seq: 3 }]);
});

test('seeking before a clear undoes it; seeking to or past it keeps it', () => {
  const t = played(5);
  t.seek(4);
  t.clearHighlights();
  t.clearHighlights('a');
  t.seek(4);
  assert.deepEqual(t.highlightClears, [{ seq: 4 }, { seq: 4, relPath: 'a' }]);
  t.seekToEnd();
  assert.equal(t.highlightClears.length, 2);
  t.seek(3);
  assert.deepEqual(t.highlightClears, []);
});

test('undoing a clear for all files brings back an earlier clear for one file', () => {
  const t = new Timeline(100);
  t.push(ev('a', 'A0', 'A1'));
  t.push(ev('a', 'A1', 'A2'));
  t.seekToEnd();
  t.clearHighlights('a');
  for (const n of [3, 4, 5]) t.push(ev('b', `B${n - 3}`, `B${n - 2}`));
  t.seekToEnd();
  t.clearHighlights();
  t.seek(4);
  assert.deepEqual(t.highlightClears, [{ seq: 3, relPath: 'a' }]);
});

test('undoing a second clear of a file brings back its first', () => {
  const t = played(2);
  t.clearHighlights('a');
  t.push(ev('a', '2', '3'));
  t.push(ev('a', '3', '4'));
  t.seekToEnd();
  t.clearHighlights('a');
  t.seek(4);
  assert.deepEqual(t.highlightClears, [{ seq: 3, relPath: 'a' }]);
});

test('a file clear during a rename follows the file to its new path', () => {
  const t = played(1);
  const ren = t.push({ ...ev('c', '1', '1'), kind: 'rename', fromUri: 'file:///w/a', fromRelPath: 'a' });
  t.begin(ren.seq);
  t.clearHighlights('a');
  assert.deepEqual(t.highlightClears, [{ seq: ren.seq + 1, relPath: 'c' }]);
});

test('replay from the start undoes every clear', () => {
  const t = played(3);
  t.clearHighlights();
  t.seekToStart();
  assert.deepEqual(t.highlightClears, []);
});

test('clearing the buffer drops the clears', () => {
  const t = played(2);
  t.clearHighlights();
  t.clearHighlights('a');
  t.clear();
  assert.deepEqual(t.highlightClears, []);
});

test('restore maps clears by position and drops ones at or before the first kept change', () => {
  const t = new Timeline(2);
  const events = played(4).all();
  t.restore(events, 5, [{ seq: 2, relPath: 'b' }, { seq: 4 }, { seq: 5, relPath: 'a' }]);
  // Kept: old seqs 3 and 4, renumbered 1 and 2. Clear 4 sits after the first kept change; 5 is the end.
  assert.deepEqual(t.highlightClears, [{ seq: 2 }, { seq: 3, relPath: 'a' }]);
});

test('restore keeps a clear made while the saved cursor change was typed', () => {
  const t = played(3);
  t.seek(2);
  t.begin(2);
  t.clearHighlights();
  const r = new Timeline(100);
  r.restore(t.all(), t.cursor, t.highlightClears);
  assert.equal(r.cursor, 2);
  assert.deepEqual(r.highlightClears, [{ seq: 3 }]);
});

test('restore without clears has none', () => {
  const t = played(2);
  t.clearHighlights();
  t.restore(played(2).all(), 3);
  assert.deepEqual(t.highlightClears, []);
});
