// The plugin's $.state contract. The deck itself lives in module memory
// (hooks/replay.ts); state keeps what must outlive a reload and what the pane
// draws. The engine requires this file to be self-contained.

/** A waiting change as a reload needs it; its texts are `text` members. */
export type SavedChange = { id: string; path: string; isTooLarge?: boolean };

/** The changes still to play, the one being typed first, and playback's switches. */
export type Saved = { changes: SavedChange[]; recorded: number; isPaused: boolean };

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
