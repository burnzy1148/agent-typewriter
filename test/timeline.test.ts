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

test('clearing again at the same point adds no second clear', () => {
  const t = played(2);
  t.clearHighlights();
  t.clearHighlights();
  t.clearHighlights('a');
  t.clearHighlights('a');
  assert.deepEqual(t.highlightClears, [{ seq: 3 }, { seq: 3, relPath: 'a' }]);
});

test('clears at or before the oldest change left in the buffer are dropped', () => {
  const t = new Timeline(3);
  t.push(ev('a', '0', '1'));
  t.seekToEnd();
  t.clearHighlights();
  t.push(ev('a', '1', '2'));
  t.push(ev('a', '2', '3'));
  t.seekToEnd();
  t.clearHighlights('a');
  t.push(ev('a', '3', '4'));
  t.push(ev('a', '4', '5'));
  // Buffer holds seqs 3 to 5: the clear at 2 is gone, the one at 4 stays.
  assert.deepEqual(t.highlightClears, [{ seq: 4, relPath: 'a' }]);
});

// ------------------------------------------------------------------ lanes

function lev(lane: string, relPath: string, before: string, after: string): NewChangeEvent {
  return { ...ev(relPath, before, after), lane };
}

const laneInfo = (id: string) => ({ id, label: id, root: '/w/' + id, color: 1, recording: true });

/** Plays the followed lane to the end and returns what was typed. */
function drain(t: Timeline): string[] {
  const out: string[] = [];
  for (let e = t.peek(); e; e = t.peek()) {
    t.begin(e.seq);
    out.push(`${e.lane ?? ''}:${e.relPath}:${e.after}`);
    t.complete(e.seq);
  }
  return out;
}

test('only the followed lane plays; the other lane queues', () => {
  const t = new Timeline(100);
  t.defineLane(laneInfo('main'));
  t.defineLane(laneInfo('feat'));
  t.push(lev('main', 'a', '', '1'));
  t.push(lev('feat', 'a', '', 'f1'));
  t.push(lev('feat', 'b', '', 'f2'));
  assert.equal(t.followed, 'main');
  assert.deepEqual(drain(t), ['main:a:1']);
  assert.equal(t.pendingCount(), 0);
  assert.equal(t.pendingCount('feat'), 2);
  assert.equal(t.firstPending('feat'), 2);
});

test('following another lane resumes it at its own cursor, and coming back resumes the first', () => {
  const t = new Timeline(100);
  t.push(lev('main', 'a', '', '1'));
  t.push(lev('feat', 'x', '', 'f1'));
  t.push(lev('main', 'a', '1', '2'));
  assert.deepEqual(drain(t).length, 2);
  t.push(lev('main', 'a', '2', '3'));
  t.follow('feat');
  assert.deepEqual(drain(t), ['feat:x:f1']);
  t.follow('main');
  assert.deepEqual(drain(t), ['main:a:3']);
});

test('following mid-change overtakes it; it stays pending in its lane', () => {
  const t = new Timeline(100);
  const a = t.push(lev('main', 'a', '', '1'));
  t.push(lev('feat', 'x', '', 'f1'));
  const token = t.begin(a.seq);
  const jumps = t.jumps;
  t.follow('feat');
  assert.notEqual(t.jumps, jumps);
  assert.equal(t.playing, undefined);
  t.complete(a.seq, token);
  assert.equal(t.stateOf(a.seq), 'pending');
  assert.equal(t.pendingCount('main'), 1);
  assert.equal(t.peek()?.lane, 'feat');
});

test('seek and skip move only the followed lane', () => {
  const t = new Timeline(100);
  const m1 = t.push(lev('main', 'a', '', '1'));
  const f1 = t.push(lev('feat', 'x', '', 'f1'));
  t.push(lev('main', 'a', '1', '2'));
  t.seekToEnd();
  assert.equal(t.pendingCount('main'), 0);
  assert.equal(t.pendingCount('feat'), 1);
  assert.equal(t.stateOf(m1.seq), 'played');
  assert.equal(t.stateOf(f1.seq), 'pending');
  t.seek(m1.seq);
  assert.equal(t.pendingCount('main'), 2);
  assert.equal(t.stateOf(f1.seq), 'pending');
  t.follow('feat');
  t.seekToEnd();
  assert.equal(t.stateOf(f1.seq), 'played');
  assert.equal(t.pendingCount('main'), 2);
});

test('the history limit counts every lane; dropped unplayed changes are counted per lane', () => {
  const t = new Timeline(3);
  t.push(lev('main', 'a', '', '1'));
  t.push(lev('feat', 'x', '', 'f1'));
  t.push(lev('feat', 'x', 'f1', 'f2'));
  t.push(lev('main', 'a', '1', '2'));
  assert.equal(t.all().length, 3);
  assert.equal(t.droppedUnplayed, 1);
  t.push(lev('feat', 'x', 'f2', 'f3'));
  assert.deepEqual(t.all().map((e) => `${e.lane}:${e.after}`), ['feat:f2', 'main:2', 'feat:f3']);
});

test('a stopped lane with no changes left is forgotten, and following moves on', () => {
  const t = new Timeline(2);
  t.defineLane(laneInfo('old'));
  t.defineLane(laneInfo('new'));
  t.push(lev('old', 'a', '', '1'));
  assert.equal(t.followed, 'old');
  t.setLaneRecording('old', false);
  assert.deepEqual(t.laneList().map((l) => [l.id, l.recording]), [['old', false], ['new', true]]);
  t.push(lev('new', 'b', '', '1'));
  t.push(lev('new', 'b', '1', '2'));
  assert.deepEqual(t.laneList().map((l) => l.id), ['new']);
  assert.equal(t.followed, 'new');
});

test('mirror states and latest states use each lane on its own', () => {
  const t = new Timeline(100);
  t.push(lev('main', 'a', '', '1'));
  t.push(lev('feat', 'feat/a', 'x', 'y'));
  drain(t);
  const m = t.mirrorStates();
  assert.equal(m.get('a')?.text, '1');
  assert.equal(m.get('feat/a')?.text, 'x');
  assert.deepEqual([...t.latestStates('feat').keys()], ['feat/a']);
  assert.deepEqual([...t.latestStates().keys()], ['a', 'feat/a']);
});

test('clear all writes a clear per lane at its own cursor; seek drops only the followed lane\'s', () => {
  const t = new Timeline(100);
  t.push(lev('main', 'a', '', '1'));
  t.push(lev('feat', 'b', '', '1'));
  t.push(lev('main', 'a', '1', '2'));
  drain(t);
  t.clearHighlights();
  assert.deepEqual(t.highlightClears, [
    { seq: 4, lane: 'main' },
    { seq: 2, lane: 'feat' },
  ]);
  t.clearHighlights('b');
  assert.deepEqual(t.highlightClears.at(-1), { seq: 2, relPath: 'b', lane: 'feat' });
  t.seek(1);
  assert.deepEqual(t.highlightClears, [
    { seq: 2, lane: 'feat' },
    { seq: 2, relPath: 'b', lane: 'feat' },
  ]);
});

test('restore keeps each lane\'s cursor, the followed lane and recording lanes', () => {
  const t = new Timeline(100);
  t.push(lev('main', 'a', '', '1'));
  t.push(lev('feat', 'b', '', '1'));
  t.push(lev('main', 'a', '1', '2'));
  t.push(lev('feat', 'b', '1', '2'));
  drain(t);
  t.follow('feat');
  t.begin(2);
  t.complete(2);
  const r = new Timeline(100);
  r.push(ev('z', '', '1'));
  r.defineLane(laneInfo('live'));
  r.restore(t.all(), t.cursor, [], {
    lanes: [{ id: 'main', label: 'main', root: '/m', color: 1 }, { id: 'feat', label: 'feat', root: '/f', color: 2 }],
    cursors: { main: t.cursorOf('main'), feat: t.cursorOf('feat') },
    followed: 'feat',
  });
  assert.equal(r.followed, 'feat');
  assert.equal(r.pendingCount('main'), 0);
  assert.equal(r.pendingCount('feat'), 1);
  assert.deepEqual(r.laneList().map((l) => [l.id, l.recording]), [['live', true], ['main', false], ['feat', false]]);
});

test('restore without lane cursors applies the one cursor to every lane', () => {
  const t = new Timeline(100);
  t.push(lev('main', 'a', '', '1'));
  t.push(lev('feat', 'b', '', '1'));
  const r = new Timeline(100);
  r.restore(t.all(), t.all()[0].seq, undefined, { followed: 'feat' });
  assert.equal(r.followed, 'feat');
  assert.equal(r.pendingCount('main'), 1);
  assert.equal(r.pendingCount('feat'), 1);
});

test('fuzz: lanes stay consistent through pushes, follows, seeks, trims and playback', () => {
  let seed = 7;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
  const lanes = ['', 'a', 'b', 'c'];
  for (let round = 0; round < 200; round++) {
    let limit = 1 + Math.floor(rnd() * 12);
    const t = new Timeline(limit);
    for (let step = 0; step < 60; step++) {
      const r = rnd();
      const lane = lanes[Math.floor(rnd() * lanes.length)];
      if (r < 0.4) t.push(lev(lane, 'f' + Math.floor(rnd() * 3), 'x', 'y'));
      else if (r < 0.55) t.follow(lane);
      else if (r < 0.65 && t.all().length > 0) t.seek(t.all()[Math.floor(rnd() * t.all().length)].seq);
      else if (r < 0.7) t.seekToEnd();
      else if (r < 0.75) t.setLimit((limit = 1 + Math.floor(rnd() * 12)));
      else {
        const e = t.peek();
        if (e) {
          const token = t.begin(e.seq);
          if (rnd() < 0.2) t.follow(lanes[Math.floor(rnd() * lanes.length)]);
          t.complete(e.seq, token);
        }
      }
      assert.ok(t.all().length <= limit);
      for (const l of t.lanesInBuffer()) {
        const states = t.laneEvents(l).map((e) => t.stateOf(e.seq));
        // Each lane's played changes are a prefix of its changes.
        const firstPending = states.indexOf('pending');
        if (firstPending !== -1) assert.ok(states.slice(firstPending).every((s) => s !== 'played'), `lane ${l}: ${states.join(',')}`);
      }
      const p = t.peek();
      if (p) assert.equal(p.lane ?? '', t.followed);
    }
  }
});

test('a played-out lane that is not recording gives way to another lane\'s new change', () => {
  const t = new Timeline(100);
  t.push(lev('', 'old', '', '1'));
  drain(t);
  t.defineLane(laneInfo('live'));
  assert.equal(t.followed, '');
  t.push(lev('live', 'a', '', '1'));
  assert.equal(t.followed, 'live');
  // Queued changes keep a stopped lane followed.
  const u = new Timeline(100);
  u.push(lev('', 'old', '', '1'));
  u.defineLane(laneInfo('live'));
  u.push(lev('live', 'a', '', '1'));
  assert.equal(u.followed, '');
});
