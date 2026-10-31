// The plugin's $.state contract. The deck itself lives in module memory
// (hooks/replay.ts); state keeps what must outlive a reload and what the pane
// draws. The engine requires this file to be self-contained.

/**
 * A kept change as a reload needs it; its texts are `text` members. `kind` says
 * whether the file was new, and `time` is when the change was recorded, in
 * epoch milliseconds.
 */
export type SavedChange = { id: string; path: string; kind: 'create' | 'modify'; time: number; isTooLarge?: boolean };

/**
 * Every change the deck keeps, oldest first (the played ones, the one being
 * typed, then the waiting ones), how many of them lead as played, and
 * playback's switches.
 */
export type Saved = { changes: SavedChange[]; played: number; recorded: number; isPaused: boolean };

/** What the pane draws: a window of the shown text around the caret, made safe to draw. */
export type View = {
  path?: string;
  isTooLarge?: boolean;
  status: 'typing' | 'paused' | 'idle';
  queued: number;
  isTyping: boolean;
  /** Lines around the caret, each cut to the columns from `firstColumn`. */
  lines: string[];
  /** 1-based number of `lines[0]` in the file. */
  firstLine: number;
  /** 0-based column of each line's first character. */
  firstColumn: number;
  /** 0-based line and column of the caret in the file. */
  caretLine: number;
  caretColumn: number;
};

declare module 'claude-code' {
  interface PluginState {
    'agent-typewriter': {
      saved: Shaped<Saved>;
      view: Shaped<View>;
      /** Member `<change id>:before` or `<change id>:after`; '' once the change is gone. */
      text: StateFamily<string>;
    };
  }
}
