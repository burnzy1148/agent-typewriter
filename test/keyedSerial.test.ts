import { test } from 'node:test';
import assert from 'node:assert/strict';
import { KeyedSerial } from '../src/keyedSerial';

/** A promise plus the function that settles it. */
function deferred<T = void>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const tick = () => new Promise((r) => setImmediate(r));

test('KeyedSerial: a task for a key starts only after the earlier one settles', async () => {
  const serial = new KeyedSerial();
  const log: string[] = [];
  const first = deferred();
  const a = serial.run('a.ts', async () => {
    log.push('first start');
    await first.promise;
    log.push('first end');
  });
  const b = serial.run('a.ts', async () => {
    log.push('second start');
  });
  await tick();
  assert.deepEqual(log, ['first start'], 'second task started while the first was running');
  first.resolve();
  await Promise.all([a, b]);
  assert.deepEqual(log, ['first start', 'first end', 'second start']);
});

test('KeyedSerial: tasks for different keys run at the same time', async () => {
  const serial = new KeyedSerial();
  const gate = deferred();
  const started: string[] = [];
  const a = serial.run('a.ts', async () => {
    started.push('a');
    await gate.promise;
  });
  const b = serial.run('b.ts', async () => {
    started.push('b');
  });
  await b;
  assert.deepEqual(started, ['a', 'b']);
  gate.resolve();
  await a;
});

test('KeyedSerial: a rejected task does not block later ones and still rejects its own caller', async () => {
  const serial = new KeyedSerial();
  const failing = serial.run('a.ts', async () => {
    throw new Error('read failed');
  });
  const next = serial.run('a.ts', async () => 'ran');
  await assert.rejects(failing, /read failed/);
  assert.equal(await next, 'ran');
});

test('KeyedSerial: returns the task result', async () => {
  const serial = new KeyedSerial();
  assert.equal(await serial.run('k', async () => 42), 42);
});

test('KeyedSerial: the key is forgotten once its last task settles', async () => {
  const serial = new KeyedSerial();
  const gate = deferred();
  const a = serial.run('a.ts', () => gate.promise);
  const b = serial.run('a.ts', async () => {});
  assert.equal(serial.has('a.ts'), true);
  gate.resolve();
  await Promise.all([a, b]);
  await tick();
  assert.equal(serial.has('a.ts'), false);
  assert.equal(serial.size, 0);

  const failing = serial.run('b.ts', async () => {
    throw new Error('x');
  });
  await assert.rejects(failing);
  await tick();
  assert.equal(serial.size, 0, 'a rejected task left its key behind');
});

test('KeyedSerial: clear forgets queued tasks; new ones no longer wait for them', async () => {
  const serial = new KeyedSerial();
  const gate = deferred();
  const log: string[] = [];
  const old = serial.run('a.ts', async () => {
    await gate.promise;
    log.push('old');
  });
  serial.clear();
  assert.equal(serial.size, 0);
  await serial.run('a.ts', async () => {
    log.push('new');
  });
  assert.deepEqual(log, ['new']);
  gate.resolve();
  await old;
  await tick();
  assert.equal(serial.has('a.ts'), false, 'the old task removed or kept the wrong entry');
  assert.deepEqual(log, ['new', 'old']);
});

test('KeyedSerial: a cleared task settling does not drop the newer chain for its key', async () => {
  const serial = new KeyedSerial();
  const oldGate = deferred();
  const newGate = deferred();
  const old = serial.run('a.ts', () => oldGate.promise);
  serial.clear();
  const fresh = serial.run('a.ts', () => newGate.promise);
  oldGate.resolve();
  await old;
  await tick();
  assert.equal(serial.has('a.ts'), true, 'the newer task was forgotten while still running');
  newGate.resolve();
  await fresh;
});
