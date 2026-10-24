import type { ChangeKind, Timeline } from './timeline';

/** What the scrubber panel renders. Plain data, posted to the webview as is. */
export interface ScrubberState {
  type: 'state';
  /** fromRelPath is set for a rename. */
  changes: Array<{ seq: number; relPath: string; kind: ChangeKind; fromRelPath?: string }>;
  /** Slider position: index of the next change to play, or changes.length when caught up. */
  index: number;
  /** Seq being typed right now, if any. */
  playingSeq: number | undefined;
  queued: number;
  paused: boolean;
  speed: number;
  watching: boolean;
  /** Whether any mirror has highlights or removal markers to clear. */
  hasHighlights: boolean;
  /** What is playing or next, e.g. "Typing #12 src/a.ts · 3 queued". */
  label: string;
  /** Position within the buffer, e.g. "4 / 12". */
  position: string;
}

export type PlaybackFacts = Omit<ScrubberState, 'type' | 'label' | 'position'>;

export type ScrubberMessage =
  | { type: 'ready' | 'togglePause' | 'finishCurrent' | 'skipToNext' | 'catchUp' | 'replayAll' | 'clearHighlights' }
  | { type: 'seek'; seq: number }
  | { type: 'speed'; value: number };

export function scrubberState(
  timeline: Timeline,
  player: { paused: boolean; speed: number; watching: boolean; hasHighlights: boolean },
): ScrubberState {
  const events = timeline.all();
  const first = events[0]?.seq ?? timeline.cursor;
  const index = Math.min(Math.max(timeline.cursor - first, 0), events.length);
  const facts: PlaybackFacts = {
    changes: events.map((e) => ({ seq: e.seq, relPath: e.relPath, kind: e.kind, ...(e.fromRelPath !== undefined && { fromRelPath: e.fromRelPath }) })),
    index,
    playingSeq: events.find((e) => timeline.stateOf(e.seq) === 'playing')?.seq,
    queued: timeline.pendingCount(),
    ...player,
  };
  return { type: 'state', ...facts, ...describePlayback(facts) };
}

/** The status text shown by the Playback panel and the mirror's status row. */
export function describePlayback(s: PlaybackFacts): { label: string; position: string } {
  const n = s.changes.length;
  const position = `${Math.min(s.index + 1, n)} / ${n}`;
  const describe = (c: { seq: number; relPath: string; fromRelPath?: string }) =>
    `#${c.seq} ${c.fromRelPath !== undefined ? `${c.fromRelPath} \u2192 ` : ''}${c.relPath}`;
  if (n === 0) return { label: s.watching ? 'Waiting for changes' : 'Not watching', position };
  const queued = s.queued ? ` \u00b7 ${s.queued} queued` : '';
  const playing = s.changes.find((c) => c.seq === s.playingSeq);
  if (playing) return { label: (s.paused ? 'Paused in ' : 'Typing ') + describe(playing) + queued, position };
  if (s.index >= n) return { label: 'Caught up', position };
  return { label: (s.paused ? 'Paused before ' : 'Next: ') + describe(s.changes[s.index]) + queued, position };
}

/** The readout at the end of the mirror's status row, with icon syntax in file names shown as typed. */
export function rowReadout(s: Pick<ScrubberState, 'label' | 'position'>): string {
  // CodeLens titles render $(name) as an icon; a backslash keeps it literal.
  return `${s.label} \u00b7 ${s.position}`.replace(/\$\([A-Za-z0-9-]+(?:~[A-Za-z]+)?\)/g, (m) => `\\${m}`);
}

const SIMPLE = new Set(['ready', 'togglePause', 'finishCurrent', 'skipToNext', 'catchUp', 'replayAll', 'clearHighlights']);

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
