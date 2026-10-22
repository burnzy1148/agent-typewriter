import { escape, Minimatch, minimatch } from 'minimatch';

export interface FilterSettings {
  include: string[];
  exclude: string[];
  /** Extensions without the leading dot, any case. Empty = any extension. */
  extensions: string[];
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
  private readonly extensions: Set<string>;

  constructor(settings: FilterSettings) {
    this.include = clean(settings.include);
    this.exclude = clean(settings.exclude);
    this.extensions = new Set(
      settings.extensions.map((e) => e.trim().replace(/^\*?\./, '').toLowerCase()).filter(Boolean),
    );
  }

  matches(relPath: string): boolean {
    return this.blockedBy(relPath) === undefined;
  }

  /** Which rule rejects the path, or undefined when it is recorded. */
  blockedBy(relPath: string): BlockedBy | undefined {
    const path = relPath.replace(/\\/g, '/').replace(/^\.\//, '');
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
   * else may still leave some files in the directory recorded. A negated glob
   * ("!src/**") excludes what it does not name, so it never prunes.
   */
  excludesDir(relDir: string): boolean {
    const dir = relDir.replace(/\\/g, '/').replace(/\/+$/, '');
    return this.exclude.some(
      (g) => g.endsWith('/**') && !new Minimatch(g).negate && minimatch(dir, g.slice(0, -3), { dot: true, nocase: false }),
    );
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
    .replace(/^#/, '[#]');
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
