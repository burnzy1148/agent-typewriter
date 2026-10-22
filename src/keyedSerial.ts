/**
 * Runs async tasks one at a time per key: a task starts only once every
 * earlier task for its key has settled. Tasks for different keys run freely.
 *
 * The recorder uses it so two reads of the same file never overlap, because
 * each one starts from the snapshot the one before it stored.
 */
export class KeyedSerial {
  /** The last task queued per key, settled either way; removed once it is still the last when it settles. */
  private readonly tails = new Map<string, Promise<void>>();

  /** Queues `task` behind the earlier tasks for `key`. A failed task does not stop later ones. */
  run<T>(key: string, task: () => Promise<T>): Promise<T> {
    const result = (this.tails.get(key) ?? Promise.resolve()).then(task);
    const tail = result.then(
      () => {},
      () => {},
    );
    this.tails.set(key, tail);
    void tail.then(() => {
      if (this.tails.get(key) === tail) this.tails.delete(key);
    });
    return result;
  }

  /** True while a task for `key` is queued or running. */
  has(key: string): boolean {
    return this.tails.has(key);
  }

  get size(): number {
    return this.tails.size;
  }

  /** Forgets every queued task. Tasks already queued still run; new ones no longer wait for them. */
  clear(): void {
    this.tails.clear();
  }
}
