import { escape, Minimatch, minimatch } from 'minimatch';

export interface FilterSettings {
  include: string[];
  exclude: string[];
  /** Extensions without the leading dot, any case. Empty = any extension. */
  extensions: string[];
}

/**
 * A relative path with '/' separators. Only on Windows is a backslash a
 * separator; elsewhere it is an ordinary file-name character and is kept, so
 * `src\\a.ts` stays a different file from `src/a.ts`.
 */
export function toSlashes(relPath: string, platform: NodeJS.Platform = process.platform): string {
  return platform === 'win32' ? relPath.replace(/\\/g, '/') : relPath;
}

/** The rule that keeps a path from being recorded. */
export type BlockedBy = 'git' | 'extension' | 'exclude' | 'include';

/**
 * Decides whether a workspace-relative path should be recorded.
 * Order: git metadata, extension allow-list, then exclude globs, then include globs.
 */
export class PathFilter {
  private readonly include: string[];
  private readonly exclude: string[];
  /** `<dir glob>/**` excludes that prune a directory walk; a negated one ("!src/**") excludes what it does not name, so never. */
  private readonly pruning: string[];
  private readonly extensions: Set<string>;

  constructor(settings: FilterSettings) {
    this.include = clean(settings.include);
    this.exclude = clean(settings.exclude);
    this.pruning = this.exclude.filter((g) => g.endsWith('/**') && !new Minimatch(g).negate).map((g) => g.slice(0, -3));
    this.extensions = new Set(
      settings.extensions.map((e) => e.trim().replace(/^\*?\./, '').toLowerCase()).filter(Boolean),
    );
  }

  matches(relPath: string): boolean {
    return this.blockedBy(relPath) === undefined;
  }

  /** Which rule rejects the path, or undefined when it is recorded. */
  blockedBy(relPath: string): BlockedBy | undefined {
    const path = toSlashes(relPath).replace(/^\.\//, '');
    // A .git file (submodule, linked worktree) is git metadata whatever the
    // settings say; **/.git/** only covers .git directories.
    if (/(^|\/)\.git$/i.test(path)) return 'git';
    if (this.extensions.size > 0 && !this.extensions.has(extensionOf(path))) return 'extension';
    if (this.exclude.some((g) => globMatch(path, g))) return 'exclude';
    if (this.include.length > 0 && !this.include.some((g) => globMatch(path, g))) return 'include';
    return undefined;
  }

  /**
   * True when an exclude glob rules out everything under this directory, so a
   * directory walk can skip it. Only `<dir glob>/**` patterns count; anything
   * else may still leave some files in the directory recorded, and negated
   * globs never prune.
   */
  excludesDir(relDir: string): boolean {
    const dir = toSlashes(relDir).replace(/\/+$/, '');
    return this.pruning.some((g) => minimatch(dir, g, { dot: true, nocase: false }));
  }

  describe(): string {
    const parts: string[] = [];
    if (this.extensions.size > 0) parts.push([...this.extensions].map((e) => '.' + e).join(' '));
    const inc = this.include.filter((g) => g !== '**/*' && g !== '**');
    if (inc.length > 0) parts.push(inc.join(', '));
    return parts.length > 0 ? parts.join(' in ') : 'all files';
  }
}

/**
 * A glob that matches exactly this workspace-relative path. Glob characters
 * become one-character classes ("[id]" -> "[[]id[]]"); backslashes can't
 * escape them because filters turn them into slashes.
 */
export function literalGlob(relPath: string): string {
  return escape(relPath.replace(/\\/g, '/'), { windowsPathsNoEscape: true, magicalBraces: true })
    .replace(/^!/, '@(!)')
    .replace(/^#/, '[#]')
    // Filters trim globs; a space in a class survives that.
    .replace(/^ +| +$/g, (spaces) => '[ ]'.repeat(spaces.length));
}

/**
 * The first selected file that the filter still rejects because of its
 * extension or an exclude glob, the rules a selection can't override. Folders
 * are skipped: their files are what the include covers.
 */
export function stillFiltered(filter: PathFilter, picked: Array<{ rel: string; isFile: boolean }>): { rel: string; by: 'extension' | 'exclude' } | undefined {
  for (const { rel, isFile } of picked) {
    if (!isFile) continue;
    const by = filter.blockedBy(rel);
    if (by === 'extension' || by === 'exclude') return { rel, by };
  }
  return undefined;
}

/**
 * The include glob for an Explorer selection: the file itself, everything
 * under a folder, or every file for a workspace folder root (`rel` undefined).
 */
export function selectionGlob(rel: string | undefined, isDir: boolean): string {
  if (rel === undefined) return '**/*';
  return isDir ? `${literalGlob(rel)}/**` : literalGlob(rel);
}

function clean(globs: string[]): string[] {
  return globs.map((g) => g.trim().replace(/\\/g, '/').replace(/^\.\//, '')).filter(Boolean);
}

function globMatch(path: string, glob: string): boolean {
  // A pattern with no slash ("*.ts", "Dockerfile") matches the file name anywhere.
  // Braces in one-character classes ("[{]") are literal (see literalGlob), so
  // such a glob is not brace-expanded.
  const nobrace = !glob.replace(/\[.\]/g, '').includes('{');
  return minimatch(path, glob, { dot: true, matchBase: !glob.includes('/'), nocase: false, nobrace });
}

export function extensionOf(path: string): string {
  const name = path.slice(path.lastIndexOf('/') + 1);
  const dot = name.lastIndexOf('.');
  return dot <= 0 ? '' : name.slice(dot + 1).toLowerCase();
}

/** Parses "ts, .java  md" style user input into ["ts","java","md"]. */
export function parseExtensionList(input: string): string[] {
  return input
    .split(/[\s,;]+/)
    .map((e) => e.trim().replace(/^\*?\./, '').toLowerCase())
    .filter(Boolean);
}

/**
 * Globs matched from the root, the way VS Code reads `files.watcherExclude`:
 * a path is covered when it, or a directory above it, matches one. Unlike
 * PathFilter, a glob without a slash names a path at the root, not a file
 * name anywhere. Negated globs are ignored.
 */
export class RootGlobs {
  private readonly globs: Minimatch[];
  /** Directory -> covered, filled as directories are checked. */
  private readonly dirs = new Map<string, boolean>();

  constructor(globs: string[]) {
    this.globs = clean(globs)
      .filter((g) => !g.startsWith('!'))
      .map((g) => new Minimatch(g.replace(/^\/+/, ''), { dot: true, nocase: false }));
  }

  get size(): number {
    return this.globs.length;
  }

  /** True when the root-relative path or a directory above it matches. */
  covers(relPath: string): boolean {
    const path = toSlashes(relPath).replace(/^\.\//, '').replace(/\/+$/, '');
    const slash = path.lastIndexOf('/');
    if (slash !== -1 && this.coversDir(path.slice(0, slash))) return true;
    return this.globs.some((g) => g.match(path));
  }

  private coversDir(dir: string): boolean {
    let hit = this.dirs.get(dir);
    if (hit === undefined) {
      const slash = dir.lastIndexOf('/');
      hit = (slash !== -1 && this.coversDir(dir.slice(0, slash))) || this.globs.some((g) => g.match(dir));
      this.dirs.set(dir, hit);
    }
    return hit;
  }
}
