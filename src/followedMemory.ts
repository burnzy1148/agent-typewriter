import type { Timeline } from './timeline';

/**
 * Remembers the followed lane as the user's choice, so recording follows it
 * again after a reload. Lanes the timeline falls back to while a buffer is
 * replaced (a restored timeline, a loaded session, a git replay) are no choice
 * of the user's: those changes run `quietly` and are not saved.
 */
export class FollowedMemory {
  private saved: string;
  private seen: string;
  private quiet = 0;
  private readonly sub: { dispose(): void };

  constructor(
    private readonly timeline: Timeline,
    private readonly save: (lane: string) => void,
    /** Called whenever the followed lane changes, saved or not. */
    private readonly changed: () => void = () => {},
  ) {
    this.saved = this.seen = timeline.followed;
    this.sub = timeline.onDidChange(() => this.onChange());
  }

  /** Runs `fn` without saving the followed lane it leads to. */
  quietly<T>(fn: () => T): T {
    this.quiet++;
    try {
      return fn();
    } finally {
      this.quiet--;
    }
  }

  private onChange(): void {
    const followed = this.timeline.followed;
    if (followed === this.seen) return;
    this.seen = followed;
    if (this.quiet === 0 && followed !== this.saved && this.timeline.lanesInBuffer().length > 0) {
      this.saved = followed;
      this.save(followed);
    }
    this.changed();
  }

  dispose(): void {
    this.sub.dispose();
  }
}
