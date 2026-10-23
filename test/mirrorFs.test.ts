import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as vscode from 'vscode';
import { MirrorFileSystem, mirrorBytes } from '../src/mirrorFs';

const text = (data: Uint8Array) => new TextDecoder().decode(data);
const settled = <T>(p: T | Thenable<T>) => {
  const state = { done: false };
  void Promise.resolve(p).then(
    () => (state.done = true),
    () => (state.done = true),
  );
  return state;
};
const tick = () => new Promise((r) => setImmediate(r));

test('mirror reads wait until open, then answer from the files', async () => {
  const fs = new MirrorFileSystem();
  const a = MirrorFileSystem.uriFor('src/a.ts');
  const stat = fs.stat(a);
  const read = fs.readFile(a);
  const missing = fs.readFile(MirrorFileSystem.uriFor('src/none.ts'));
  const dir = fs.readDirectory(MirrorFileSystem.uriFor('src'));
  const states = [stat, read, missing, dir].map(settled);
  await tick();
  assert.ok(states.every((s) => !s.done), 'a read answered before open');

  fs.seed([[a, mirrorBytes('a\n', '\n')]]);
  fs.open();
  assert.equal((await stat).type, vscode.FileType.File);
  assert.equal(text(await read), 'a\n');
  await assert.rejects(Promise.resolve(missing), (e: vscode.FileSystemError) => e.code === 'FileNotFound');
  assert.deepEqual(await dir, [['a.ts', vscode.FileType.File]]);

  // Once open, reads answer synchronously again.
  assert.equal(text(fs.readFile(a) as Uint8Array), 'a\n');
  assert.throws(() => fs.stat(MirrorFileSystem.uriFor('src/none.ts')), (e: vscode.FileSystemError) => e.code === 'FileNotFound');
  fs.open();
});

test('seed adds only new files, in one change event, with their line ending', () => {
  const fs = new MirrorFileSystem();
  fs.open();
  const a = MirrorFileSystem.uriFor('a.ts');
  const b = MirrorFileSystem.uriFor('b.ts');
  fs.writeFile(a, mirrorBytes('played\n', '\n'));
  const events: vscode.FileChangeEvent[][] = [];
  fs.onDidChangeFile((e) => events.push(e));
  const added = fs.seed([
    [a, mirrorBytes('older\n', '\n')],
    [b, mirrorBytes('x\ny\n', '\r\n')],
  ]);
  assert.equal(added, 1);
  assert.equal(events.length, 1);
  assert.deepEqual(
    events[0].map((e) => [e.type, e.uri.path]),
    [[vscode.FileChangeType.Created, '/b.ts']],
  );
  assert.equal(text(fs.readFile(a) as Uint8Array), 'played\n', 'seed replaced a file that was already there');
  assert.equal(text(fs.readFile(b) as Uint8Array), 'x\r\ny\r\n');
  assert.equal(fs.seed([]), 0);
  assert.equal(events.length, 1, 'an empty seed fired an event');
});

test('deleteFile removes one file and keeps files under a directory of the same name', () => {
  const fs = new MirrorFileSystem();
  fs.open();
  const file = MirrorFileSystem.uriFor('src/config');
  const inside = MirrorFileSystem.uriFor('src/config/default.json');
  fs.writeFile(file, mirrorBytes('old\n', '\n'));
  fs.writeFile(inside, mirrorBytes('{}\n', '\n'));
  const events: vscode.FileChangeEvent[][] = [];
  fs.onDidChangeFile((e) => events.push(e));
  fs.deleteFile(file);
  assert.equal(fs.has(file), false);
  assert.equal(text(fs.readFile(inside) as Uint8Array), '{}\n');
  assert.deepEqual(events.flat().map((e) => [e.type, e.uri.path]), [[vscode.FileChangeType.Deleted, '/src/config']]);
  fs.deleteFile(file);
  assert.equal(events.length, 1, 'deleting a missing file fired an event');
});
