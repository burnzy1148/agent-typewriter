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

/**
 * What the pane draws: a window of the code view's rows around the caret, made
 * safe to draw. The code view is a unified diff of a file's baseline and its
 * text: the file playback shows, or the file of a pinned tab.
 */
export type View = {
  /** The file playback shows, which the header names. */
  path?: string;
  isTooLarge?: boolean;
  status: 'typing' | 'paused' | 'idle';
  queued: number;
  isTyping: boolean;
  /** The pinned tab's file, which the code view shows instead of playback's; whether its change was too large to type. */
  pinned?: { path: string; isTooLarge?: boolean };
  /** Diff rows around the caret: each a marker (` `, `+` or `-`) then its line, cut to the columns from `firstColumn`. */
  rows: string[];
  /** How many lines of the baseline (`oldBefore`) and of the text (`newBefore`) come before `rows[0]`. */
  oldBefore: number;
  newBefore: number;
  /** 0-based column of each line's first character. */
  firstColumn: number;
  /** The index in `rows` of the caret's row, and the caret's 0-based line and column in the text. */
  caretRow: number;
  caretLine: number;
  caretColumn: number;
  /** The shown change's caption, what the agent wrote before its call, on one line; absent when it has none. */
  caption?: string;
};

/**
 * A press of Clear marks: `at` is the recording number of the first change
 * that had not played then, the change being typed counting as played. From
 * that change on, each file's text as it was is its baseline.
 */
export type Clear = { at: number };

/** What Clear marks pressed, newest last, as a reload needs it. */
export type Marks = { clears: Clear[] };

/** A file tab: the file's path, and the number of the latest change the followed lane typed into it. */
export type Tab = { path: string; last: number };

/** The tab row: a tab per file the followed lane typed, in the order it first typed them; the file playback shows; and the pinned file. */
export type Tabs = { tabs: Tab[]; shown?: string; pinned?: string };

/**
 * One kept change as the pane lists it: its place in the session, the tool
 * that made it, its absolute path, whether it has played, is being typed or
 * waits, and the lines it adds and removes. `mainTurnId` and `agentCallId`
 * are the change's links (CallLinks), which group it into its turn's chapter
 * and anchor that turn's chip; each is absent when the change lacks it.
 * `caption` is the change's caption cut with `…` to 300 characters, for the
 * row's hover card; absent when the change has none.
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
  caption?: string;
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
 * single spaces, other control characters as visible stand-ins, at most 200
 * characters with a cut one ending in `…`, '' when it had none), and whether
 * it has ended.
 */
export type TurnInfo = { turnId: string; number: number; prompt: string; isEnded?: boolean };

/**
 * The main conversation's turns as a reload needs them: the number the next
 * turn takes, and the running turn, every turn a kept change names and every
 * turn that started an agent the plugin still knows, oldest first.
 */
export type Turns = { next: number; turns: TurnInfo[] };

/** How the pane groups its changes list: into chapters by turn, or by file. */
export type Grouping = 'turn' | 'file';

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
      /** How the person chose to group the changes list. */
      grouping: Shaped<Grouping>;
      /** What Clear marks pressed, for a reload. */
      marks: Shaped<Marks>;
      /** The file tabs over the code view. */
      tabs: Shaped<Tabs>;
      /**
       * Member `<change id>:before` or `<change id>:after`, the change's texts,
       * and `<change id>:caption`, its caption, absent or '' when it has none;
       * each '' once the change is gone.
       */
      text: StateFamily<string>;
    };
  }
}
