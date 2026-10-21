import type { ChangeKind, Timeline } from './timeline';

/** What the scrubber panel renders. Plain data, posted to the webview as is. */
export interface ScrubberState {
  type: 'state';
  changes: Array<{ seq: number; relPath: string; kind: ChangeKind }>;
  /** Slider position: index of the next change to play, or changes.length when caught up. */
  index: number;
  /** Seq being typed right now, if any. */
  playingSeq: number | undefined;
  queued: number;
  paused: boolean;
  speed: number;
  watching: boolean;
}

export type ScrubberMessage =
  | { type: 'ready' | 'togglePause' | 'finishCurrent' | 'skipToNext' | 'catchUp' | 'replayAll' }
  | { type: 'seek'; seq: number }
  | { type: 'speed'; value: number };

export function scrubberState(
  timeline: Timeline,
  player: { paused: boolean; speed: number; watching: boolean },
): ScrubberState {
  const events = timeline.all();
  const first = events[0]?.seq ?? timeline.cursor;
  const index = Math.min(Math.max(timeline.cursor - first, 0), events.length);
  return {
    type: 'state',
    changes: events.map((e) => ({ seq: e.seq, relPath: e.relPath, kind: e.kind })),
    index,
    playingSeq: events.find((e) => timeline.stateOf(e.seq) === 'playing')?.seq,
    queued: timeline.pendingCount(),
    ...player,
  };
}

const SIMPLE = new Set(['ready', 'togglePause', 'finishCurrent', 'skipToNext', 'catchUp', 'replayAll']);

/** Validates a message posted by the webview; anything unexpected comes back undefined. */
export function parseScrubberMessage(raw: unknown): ScrubberMessage | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined;
  const m = raw as Record<string, unknown>;
  if (typeof m.type !== 'string') return undefined;
  if (SIMPLE.has(m.type)) return { type: m.type as 'ready' };
  if (m.type === 'seek' && Number.isSafeInteger(m.seq) && (m.seq as number) >= 0) return { type: 'seek', seq: m.seq as number };
  if (m.type === 'speed' && typeof m.value === 'number' && Number.isFinite(m.value) && m.value > 0) {
    return { type: 'speed', value: m.value };
  }
  return undefined;
}
