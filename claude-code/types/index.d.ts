// The plugin's $.state contract. The deck itself lives in module memory
// (hooks/replay.ts); state keeps what must outlive a reload and what the pane
// draws. The engine requires this file to be self-contained.

/** The file tools whose changes the plugin records. */
export type Tool = 'Edit' | 'Write';

/**
 * A kept change as a reload needs it; its texts are `text` members. `number`
 * is its place in the session's recording order, from 1, and `tool` the tool
 * that made it, absent when an earlier version saved the change. `kind` says
 * whether the file was new, and `time` is when the change was recorded, in
 * epoch milliseconds.
 */
export type SavedChange = { id: string; number: number; tool?: Tool; path: string; kind: 'create' | 'modify'; time: number; isTooLarge?: boolean } & CallLinks;

/**
 * Where a change came from in the conversation, beside its id, which is the
 * `tool_use_id` of the call that made it. `turnId` is the turn that call ran
 * in, of whichever loop made it; `agentId` the subagent or teammate whose loop
 * made it, absent for the main conversation. For an agent's change,
 * `mainTurnId` is the main conversation's turn that started the agent at the
 * top of its chain, and `agentCallId` the `tool_use_id` of the `Agent` (or
 * `Workflow`) call that started it; for a main conversation change
 * `mainTurnId` is `turnId` and `agentCallId` is absent. Each is absent when
 * the plugin did not see it (a change saved by an earlier version, a turn
 * that began before a reload).
 */
export type CallLinks = { turnId?: string; agentId?: string; mainTurnId?: string; agentCallId?: string };

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

/**
 * One kept change as the pane lists it: its place in the session, the tool
 * that made it, its absolute path, whether it has played, is being typed or
 * waits, and the lines it adds and removes. `mainTurnId` and `agentCallId`
 * are the change's links (CallLinks), which group it into its turn's chapter
 * and anchor that turn's chip; each is absent when the change lacks it.
 */
export type Row = {
  id: string;
  number: number;
  tool?: Tool;
  path: string;
  state: 'played' | 'playing' | 'pending';
  isTooLarge?: boolean;
  added: number;
  removed: number;
  mainTurnId?: string;
  agentCallId?: string;
};

/**
 * The pane's list of kept changes, oldest first; how many changes recorded
 * before the oldest of them were dropped; the id of the change the pane
 * shows, which is being typed, cued to play next, or done; and whether
 * playback is paused, which the chips on the conversation's call rows read
 * here rather than from `view`, which changes on every tick while typing.
 */
export type Listing = { rows: Row[]; dropped: number; current?: string; isPaused: boolean };

/**
 * Where an agent hangs off the main conversation, as `agent.spawn` showed it:
 * the main conversation's turn and the `Agent` (or `Workflow`) call that
 * started the agent at the top of its chain. Kept so a change an agent makes
 * after a reload still gets them.
 */
export type AgentLink = { agentId: string; mainTurnId?: string; agentCallId?: string };

/**
 * A main conversation turn the plugin saw start: its id, its number in the
 * session from 1, the prompt that started it on one line (whitespace runs as
 * single spaces, at most 200 characters, '' when it had none), and whether it
 * has ended.
 */
export type TurnInfo = { turnId: string; number: number; prompt: string; isEnded?: boolean };

/**
 * The main conversation's turns as a reload needs them: the number the next
 * turn takes, and the running turn and every turn a kept change names, oldest
 * first.
 */
export type Turns = { next: number; turns: TurnInfo[] };

declare module 'claude-code' {
  interface PluginState {
    'agent-typewriter': {
      saved: Shaped<Saved>;
      view: Shaped<View>;
      listing: Shaped<Listing>;
      /** The agents started this session, oldest first, at most the newest 200. */
      agents: Shaped<AgentLink[]>;
      /** The main conversation's turns, for the changes list's chapters. */
      turns: Shaped<Turns>;
      /** Member `<change id>:before` or `<change id>:after`; '' once the change is gone. */
      text: StateFamily<string>;
    };
  }
}
