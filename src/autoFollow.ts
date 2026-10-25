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
  /** Whether a change was being typed at the last timeline change. */
  private wasPlaying = false;
  /** The followed lane at the last timeline change. */
  private seenFollowed: string;
  private timer: NodeJS.Timeout | undefined;
  private readonly sub: { dispose(): void };

  constructor(
    private readonly timeline: Timeline,
    private readonly enabled: () => boolean,
  ) {
    this.seenFollowed = timeline.followed;
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
    const playing = this.timeline.playing !== undefined;
    // A lane just followed (by hand, at start, or by this) gets its own quiet period before anything moves on from it.
    const switched = this.timeline.followed !== this.seenFollowed;
    this.seenFollowed = this.timeline.followed;
    // A change that just finished typing counts too: the quiet starts when typing ends, not when it began.
    if (switched || playing || this.wasPlaying || this.timeline.pendingCount() > 0) this.quietSince = Date.now();
    this.wasPlaying = playing;
    this.check();
  }

  dispose(): void {
    clearTimeout(this.timer);
    this.sub.dispose();
  }
}
