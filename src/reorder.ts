/**
 * Holds recorded changes briefly so they can be released in write order.
 *
 * File watchers do not always report writes in the order they happened
 * (Windows can lag by seconds), and the timeline is append-only, so order has
 * to be settled before a change is pushed. Each item waits until `window` ms
 * after its write time, then items go out sorted by write time.
 */

export interface Scheduler {
  now(): number;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

const realScheduler: Scheduler = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
};

interface Held<T> {
  item: T;
  key: number;
  seq: number;
  /** Earliest release time: key + window. */
  due: number;
  /** Released by this time even if an earlier burst is still pending: key + 2 × window. */
  cap: number;
}

export class ReorderBuffer<T> {
  private held: Held<T>[] = [];
  private readonly lastKeyByFile = new Map<string, number>();
  /** First watcher arrival of each debounce burst that has not finished reading yet. */
  private readonly pendingBursts = new Set<{ firstArrival: number }>();
  private nextSeq = 0;
  private timer: unknown;

  constructor(
    private readonly release: (items: T[]) => void,
    private readonly window: () => number,
    private readonly clock: Scheduler = realScheduler,
  ) {}

  get size(): number {
    return this.held.length;
  }

  /**
   * Holds `item` with write time `key`. A file's changes never swap: a key
   * earlier than that file's previous one is raised to match it.
   */
  add(item: T, key: number, fileKey: string): void {
    const last = this.lastKeyByFile.get(fileKey);
    const k = last !== undefined && last > key ? last : key;
    this.lastKeyByFile.set(fileKey, k);
    const w = Math.max(0, this.window());
    this.held.push({ item, key: k, seq: this.nextSeq++, due: k + w, cap: k + 2 * w });
    this.held.sort((a, b) => a.key - b.key || a.seq - b.seq);
    this.pump();
  }

  /**
   * Marks a debounce burst whose change is not read yet. Held items that it
   * could precede wait for it (up to their cap). Call the returned function
   * when the burst has been read, whether or not it produced a change.
   */
  pending(firstArrival: number): () => void {
    const entry = { firstArrival };
    this.pendingBursts.add(entry);
    return () => {
      if (this.pendingBursts.delete(entry)) this.pump();
    };
  }

  /** Releases everything held right now, in order. */
  drain(): void {
    this.clearTimer();
    const out = this.held.splice(0);
    if (out.length > 0) this.release(out.map((h) => h.item));
  }

  dispose(): void {
    this.clearTimer();
    this.held = [];
    this.pendingBursts.clear();
    this.lastKeyByFile.clear();
  }

  private blocked(h: Held<T>): boolean {
    for (const p of this.pendingBursts) if (p.firstArrival <= h.due) return true;
    return false;
  }

  /** Releases the longest ready prefix, then schedules the next check. */
  private pump(): void {
    this.clearTimer();
    const now = this.clock.now();
    let n = 0;
    while (n < this.held.length) {
      const h = this.held[n];
      if (now < h.due || (now < h.cap && this.blocked(h))) break;
      n++;
    }
    if (n > 0) this.release(this.held.splice(0, n).map((h) => h.item));

    const next = this.held[0];
    if (!next) return;
    const at = now < next.due ? next.due : next.cap;
    this.timer = this.clock.setTimeout(() => {
      this.timer = undefined;
      this.pump();
    }, Math.max(0, at - now));
  }

  private clearTimer(): void {
    if (this.timer !== undefined) this.clock.clearTimeout(this.timer);
    this.timer = undefined;
  }
}

/**
 * Write time used to order a change. A write cannot follow the watcher event
 * that reported it, and lag beyond the window is out of reach anyway, so the
 * file's mtime is kept within [firstArrival - window, lastArrival].
 */
export function clampOrderKey(mtime: number, firstArrival: number, lastArrival: number, window: number): number {
  if (!Number.isFinite(mtime)) return firstArrival;
  return Math.min(lastArrival, Math.max(firstArrival - window, mtime));
}

export const AUTO_REORDER_WINDOW_MS = { win32: 2500, other: 250 } as const;

/** Resolves `agentTypewriter.reorderWindowMs`: "auto" or anything invalid uses the platform default. */
export function resolveReorderWindow(value: unknown, platform: string): number {
  if (typeof value === 'number' && Number.isFinite(value) && value >= 0) return value;
  return platform === 'win32' ? AUTO_REORDER_WINDOW_MS.win32 : AUTO_REORDER_WINDOW_MS.other;
}
