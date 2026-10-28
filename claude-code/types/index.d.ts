// The plugin's $.state contract: the playback deck, kept for the session.
// hooks/replay.ts imports these types; the engine requires this file to be
// self-contained.

/** One edit to type; each offset is into the text after every earlier hunk. */
export type DeckHunk = { offset: number; deleteText: string; insertText: string; continues?: boolean };

/** One recorded change. A too-large change keeps no text. */
export type Change = { id: string; path: string; before: string; after: string; isTooLarge?: boolean };

export type Playback = {
  change: Change;
  hunks: DeckHunk[];
  hunk: number;
  /** Code units of the current hunk's deleteText already backspaced. */
  deleted: number;
  /** Code units of the current hunk's insertText already typed. */
  typed: number;
  text: string;
  caret: number;
  /** Typing budget carried over from earlier ticks, in code units. */
  credit: number;
};

/** What the pane shows: the playing change, or the last one played. */
export type Shown = { path: string; text: string; caret: number; isTooLarge?: boolean };

export type Deck = {
  queue: Change[];
  playing?: Playback;
  shown?: Shown;
  isPaused: boolean;
  /** Ticks to wait before starting the next change. */
  hold: number;
  /** Changes recorded this session, dropped ones included. */
  recorded: number;
};

declare module 'claude-code' {
  interface PluginState {
    'agent-typewriter': { deck: Shaped<Deck> };
  }
}
