import { autoFollowDecision } from './lanes';
import type { Timeline } from './timeline';

/**
 * Moves playback to the lane with the oldest queued change once the followed
 * lane is caught up and has been quiet for a few seconds, while
 * `agentTypewriter.autoFollow` is on. It never switches in the middle of a change.
 */
export class AutoFollow {
  /** When something was last typed or queued in the followed lane. */
  private quietSince = Date.now();
  private timer: NodeJS.Timeout | undefined;
  private readonly sub: { dispose(): void };

  constructor(
    private readonly timeline: Timeline,
    private readonly enabled: () => boolean,
  ) {
    this.sub = timeline.onDidChange(() => this.onChange());
  }

  /** Looks again now, as after the setting is turned on. */
  check(): void {
    clearTimeout(this.timer);
    this.timer = undefined;
    const t = this.timeline;
    const d = autoFollowDecision({
      enabled: this.enabled(),
      playing: t.playing !== undefined,
      followed: t.followed,
      lanes: t.laneList().map((l) => ({ id: l.id, recording: l.recording, lastActivity: 0, firstPendingSeq: t.firstPending(l.id) })),
      quietSince: this.quietSince,
      now: Date.now(),
    });
    if (d.follow !== undefined) {
      this.quietSince = Date.now();
      t.follow(d.follow);
    } else if (d.checkIn !== undefined) {
      this.timer = setTimeout(() => this.check(), d.checkIn);
    }
  }

  private onChange(): void {
    if (this.timeline.playing !== undefined || this.timeline.pendingCount() > 0) this.quietSince = Date.now();
    this.check();
  }

  dispose(): void {
    clearTimeout(this.timer);
    this.sub.dispose();
  }
}
