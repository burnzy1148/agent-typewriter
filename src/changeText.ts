/** A change's before and after text, LF-normalized. */
export interface ChangeText {
  readonly before: string;
  readonly after: string;
}

/** Reads a change's text back from where it was saved. Throws when it cannot. */
export type TextReader = () => ChangeText;

/** Characters of saved change text kept in memory after being read, newest read kept. */
export const READ_CACHE_CHARS = 32 * 1024 * 1024;

const EMPTY: ChangeText = { before: '', after: '' };

/**
 * Text read back from saved changes, least recently read dropped first. Text
 * read again comes back as the same strings, so comparing it is cheap.
 */
export class ReadCache {
  private readonly texts = new Map<TextHolder, ChangeText>();
  private used = 0;

  constructor(private max: number) {}

  get(holder: TextHolder): ChangeText | undefined {
    const text = this.texts.get(holder);
    if (text) {
      this.texts.delete(holder);
      this.texts.set(holder, text);
    }
    return text;
  }

  put(holder: TextHolder, text: ChangeText): void {
    this.delete(holder);
    this.texts.set(holder, text);
    this.used += holder.chars;
    // The text just read stays, however big.
    for (const [h] of this.texts) {
      if (this.used <= this.max || h === holder) break;
      this.delete(h);
    }
  }

  delete(holder: TextHolder): void {
    if (this.texts.delete(holder)) this.used -= holder.chars;
  }

  /** Characters held, for tests. */
  get chars(): number {
    return this.used;
  }

  setMax(max: number): void {
    this.max = max;
  }

  clear(): void {
    this.texts.clear();
    this.used = 0;
  }
}

export const readCache = new ReadCache(READ_CACHE_CHARS);

let reportReadError: (message: string) => void = () => {};
/** A failed read was reported; the first one says it all, so later ones stay quiet. */
let reported = false;

/** Where the first change whose saved text cannot be read is reported. */
export function onTextReadError(report: (message: string) => void): void {
  reportReadError = report;
  reported = false;
}

/**
 * Owns one change's text. It starts in memory with the strings captured when
 * the change was recorded. Once those are saved, `offload` lets them go and
 * reads come from the saved copy, through the shared cache.
 */
export class TextHolder {
  private text: ChangeText | undefined;
  private reader: TextReader | undefined;
  /** Whoever keeps the saved copy, while there is one. */
  private keeper: unknown;
  readonly chars: number;

  constructor(before: string, after: string);
  constructor(chars: number, reader: TextReader, keeper: unknown);
  constructor(a: string | number, b: string | TextReader, keeper?: unknown) {
    if (typeof a === 'string') {
      this.text = { before: a, after: b as string };
      this.chars = a.length + (b as string).length;
    } else {
      this.chars = a;
      this.reader = b as TextReader;
      this.keeper = keeper;
    }
  }

  /** Text not saved anywhere else yet, or pinned. */
  get inMemory(): boolean {
    return this.text !== undefined;
  }

  get owner(): unknown {
    return this.keeper;
  }

  read(): ChangeText {
    if (this.text) return this.text;
    const cached = readCache.get(this);
    if (cached) return cached;
    let text: ChangeText;
    try {
      text = this.reader!();
    } catch (err) {
      if (!reported) reportReadError(`Could not read a saved change's text, so it reads as empty: ${err instanceof Error ? err.message : String(err)}`);
      reported = true;
      return EMPTY;
    }
    readCache.put(this, text);
    return text;
  }

  /** The text is saved where `reader` reads it: let go of the strings, keeping them in the cache. */
  offload(reader: TextReader, keeper: unknown): void {
    const text = this.text;
    this.reader = reader;
    this.keeper = keeper;
    this.text = undefined;
    if (text) readCache.put(this, text);
  }

  /** Keeps the text in memory from now on, before its saved copy goes away. */
  pin(): void {
    if (!this.text) this.text = this.read();
    readCache.delete(this);
    this.reader = undefined;
    this.keeper = undefined;
  }
}

const holders = new WeakMap<object, TextHolder>();

/**
 * `fields` with `before` and `after` read through `holder`. They are
 * enumerable getters, so spreading the result or turning it into JSON gives
 * plain text, and comparing it with a plain object compares the text.
 */
export function withText<T extends object>(fields: T, holder: TextHolder): T & ChangeText {
  const out = { ...fields } as Record<string, unknown>;
  delete out.before;
  delete out.after;
  Object.defineProperty(out, 'before', { get: () => holder.read().before, enumerable: true, configurable: true });
  Object.defineProperty(out, 'after', { get: () => holder.read().after, enumerable: true, configurable: true });
  holders.set(out, holder);
  return out as T & ChangeText;
}

/** `e`'s fields with `patch` applied, sharing its text without reading it. */
export function rebind<T extends ChangeText>(e: T, patch: Partial<Omit<T, 'before' | 'after'>>): T {
  const fields: Record<string, unknown> = {};
  for (const k of Object.keys(e)) if (k !== 'before' && k !== 'after') fields[k] = (e as unknown as Record<string, unknown>)[k];
  return withText({ ...fields, ...patch }, textHolder(e)) as unknown as T;
}

/** The holder of `e`'s text; a plain object's text gets a new one. */
export function textHolder(e: ChangeText): TextHolder {
  return holders.get(e) ?? new TextHolder(e.before, e.after);
}

/** Characters of before and after text, without reading saved text. */
export function textChars(e: ChangeText): number {
  return holders.get(e)?.chars ?? e.before.length + e.after.length;
}

export type TextSide = 'before' | 'after';
/** Reads one side of a change's text. */
export type ReadText = (e: ChangeText, side: TextSide) => string;

export const readSide: ReadText = (e, side) => e[side];

/**
 * Reads for passes that go over the same changes' text again and again, like
 * the highlight passes. Each pass keeps what it read and reuses what the pass
 * before it read, so the text a pass needs stays in memory however much of it
 * there is, and nothing only an older pass needed does.
 */
export class TextPasses {
  private last = new Map<TextHolder, { before?: string; after?: string }>();

  run<T>(pass: (read: ReadText) => T): T {
    const now = new Map<TextHolder, { before?: string; after?: string }>();
    const read: ReadText = (e, side) => {
      const holder = textHolder(e);
      let kept = now.get(holder);
      if (!kept) now.set(holder, (kept = {}));
      return (kept[side] ??= this.last.get(holder)?.[side] ?? e[side]);
    };
    try {
      return pass(read);
    } finally {
      this.last = now;
    }
  }
}
