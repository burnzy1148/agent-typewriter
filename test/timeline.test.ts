import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Timeline, type NewChangeEvent } from '../src/timeline';
import { PathFilter, parseExtensionList } from '../src/filter';

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
});

test('parseExtensionList accepts loose input', () => {
  assert.deepEqual(parseExtensionList(' .ts, java  *.MD;py '), ['ts', 'java', 'md', 'py']);
});
