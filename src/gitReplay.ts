/**
 * Builds timeline events from git history: one change per file per commit,
 * oldest commit first, with before and after text read from git objects. The
 * repository is only read (no checkout, fetch or ref update; a partial
 * clone's missing objects and Git LFS content are not downloaded), and the
 * working tree is never consulted, so the replay shows what was committed.
 *
 * Every git call runs in the workspace folder; paths are relative to it.
 */
import { countChanges, detectEol, normalizeEol } from './planner';
import { promises as fsp } from 'node:fs';
import * as nodePath from 'node:path';
import { execGitWith, limitGit, readBlob, type GitRunner } from './gitBaseline';
import { decodeBytes, isBinaryText, looksBinary } from './textDecode';
import type { ChangeKind, NewChangeEvent } from './timeline';

/** A git failure worth showing as is: git's own reason, without the command line. */
export class GitReplayError extends Error {}

export interface GitCommit {
  sha: string;
  /** Committer time, epoch millis. */
  time: number;
  subject: string;
}

export interface FileChange {
  /** Folder-relative, forward slashes. */
  path: string;
  kind: ChangeKind;
  /** Blob of the regular file before the commit; undefined for a create. */
  beforeSha?: string;
  /** Blob of the regular file after the commit; undefined for a delete. */
  afterSha?: string;
}

export interface ReplayOptions {
  /** True when the folder-relative path should be replayed. */
  filter?: (path: string) => boolean;
  /** Blobs larger than this are skipped. */
  maxBytes?: number;
  /** Text of a blob, or undefined when it is binary. Defaults to UTF-8 by byte order mark. */
  decode?: (bytes: Uint8Array, path: string) => string | undefined;
  /** The `uri` recorded on each event. */
  uriOf?: (path: string) => string;
  /** The `relPath` recorded on each event, which names its mirror. Defaults to the folder-relative path. */
  mirrorPathOf?: (path: string) => string;
  /** Checked before each commit and file; a cancelled build throws GitReplayError. */
  isCancelled?: () => boolean;
}

export interface ReplaySkips {
  /** Left out by `filter`. */
  filtered: number;
  binary: number;
  tooLarge: number;
  /** A blob git could not read, such as one a partial clone does not have. */
  unreadable: number;
  /** A Git LFS pointer, whose content is not downloaded. */
  lfs: number;
  /** Commits at a shallow clone's boundary, whose parents are missing; counted in commits, not files. */
  shallow: number;
}

export interface Replay {
  /** Every non-merge commit in the range, oldest first, whether or not it added events. */
  commits: GitCommit[];
  /** Oldest first; `time` is the commit time. */
  events: NewChangeEvent[];
  /** For each event, the commit it came from. */
  commitOf: GitCommit[];
  skipped: ReplaySkips;
}

const REGULAR_FILE_MODES = new Set(['100644', '100755']);

/** Commits whose changes are read at once. */
const COMMIT_BATCH = 16;

/**
 * The runner for replays: like `runGit`, except that git never fetches an
 * object a partial clone lacks (git 2.44+) and Git LFS leaves its pointers
 * alone, so reading history never downloads into the repository.
 */
export const runReplayGit: GitRunner = limitGit(execGitWith({ GIT_NO_LAZY_FETCH: '1', GIT_LFS_SKIP_SMUDGE: '1' }), {
  concurrency: 8,
  attempts: 5,
  backoffMs: 50,
});

/** A Git LFS pointer file, as stored in place of the content. */
const LFS_POINTER = /^version https:\/\/git-lfs\.github\.com\/spec\/v1\noid sha256:[0-9a-f]{64}\nsize \d+\n$/;

/**
 * The rev-list arguments for what the user typed: whitespace-separated
 * revisions in git's syntax, where a lone plain revision means that one
 * commit. Throws GitReplayError for empty input or a token git would read as
 * an option.
 */
export function resolveRange(input: string): string[] {
  const tokens = input.trim().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) throw new GitReplayError('Enter a commit or a range such as main..feature.');
  const option = tokens.find((t) => t.startsWith('-'));
  if (option) throw new GitReplayError(`"${option}" is not a revision.`);
  if (tokens.length === 1 && !isRangeToken(tokens[0])) return [`${tokens[0]}^!`];
  return tokens;
}

/** True for a token that already names a set of commits rather than one commit. */
function isRangeToken(t: string): boolean {
  return t.includes('..') || t.startsWith('^') || /\^(!|@|-\d*)$/.test(t);
}

/** Parses `rev-list --format=%H %ct %s`: a `commit <sha>` header line, then the formatted line. */
export function parseCommits(out: string): GitCommit[] {
  const lines = out.split('\n');
  const commits: GitCommit[] = [];
  for (let i = 0; i + 1 < lines.length; i += 2) {
    // A subject can hold a bare CR or a Unicode line separator, which `.` alone does not match.
    const m = /^([0-9a-f]+) (\d+) ?(.*)$/s.exec(lines[i + 1]);
    if (!lines[i].startsWith('commit ') || !m) continue;
    commits.push({ sha: m[1], time: Number(m[2]) * 1000, subject: m[3] });
  }
  return commits;
}

/** Parses `diff-tree -r -z --raw`: `:<old mode> <new mode> <old sha> <new sha> <status>` then the path, NUL separated. */
export function parseDiffTree(out: string): FileChange[] {
  const fields = out.split('\0');
  const changes: FileChange[] = [];
  for (let i = 0; i + 1 < fields.length; i++) {
    const meta = fields[i];
    if (!meta.startsWith(':')) continue;
    const path = fields[++i];
    const [oldMode, newMode, oldSha, newSha] = meta.slice(1).split(' ');
    const before = REGULAR_FILE_MODES.has(oldMode) ? oldSha : undefined;
    const after = REGULAR_FILE_MODES.has(newMode) ? newSha : undefined;
    if (before === undefined && after === undefined) continue;
    const kind: ChangeKind = before === undefined ? 'create' : after === undefined ? 'delete' : 'modify';
    changes.push({ path, kind, ...(before !== undefined && { beforeSha: before }), ...(after !== undefined && { afterSha: after }) });
  }
  return changes;
}

/** The non-merge commits of the range, oldest first. */
export async function listCommits(folder: string, revs: string[], run: GitRunner = runReplayGit): Promise<GitCommit[]> {
  const out = await git(run, folder, ['rev-list', '--reverse', '--topo-order', '--no-merges', '--format=%H %ct %s', ...revs, '--']);
  return parseCommits(out);
}

/** The regular files a commit changed under the folder, against its parent (or nothing, for a root commit). */
export async function commitChanges(folder: string, sha: string, run: GitRunner = runReplayGit): Promise<FileChange[]> {
  const out = await git(run, folder, ['diff-tree', '-r', '-z', '--raw', '--no-renames', '--no-commit-id', '--root', '--relative', sha, '--']);
  return parseDiffTree(out);
}

/** Reads the range's commits and turns their file changes into timeline events. */
export async function buildReplay(folder: string, revs: string[], options: ReplayOptions = {}, run: GitRunner = runReplayGit): Promise<Replay> {
  const { filter = () => true, maxBytes = Infinity, uriOf = (p: string) => p, mirrorPathOf = (p: string) => p, isCancelled = () => false } = options;
  const decode = options.decode ?? ((bytes: Uint8Array) => decodeBytes(bytes));
  const skipped: ReplaySkips = { filtered: 0, binary: 0, tooLarge: 0, unreadable: 0, lfs: 0, shallow: 0 };
  const [commits, shallow] = await Promise.all([listCommits(folder, revs, run), shallowCommits(folder, run)]);
  const stopIfCancelled = () => {
    if (isCancelled()) throw new GitReplayError('Cancelled.');
  };
  // A file's after blob is its next change's before blob; read each once.
  const texts = new Map<string, Promise<BlobText>>();
  const textOf = (path: string, sha: string): Promise<BlobText> => {
    const key = `${sha}\0${path}`;
    let t = texts.get(key);
    if (!t) texts.set(key, (t = readText(folder, path, sha, maxBytes, decode, run)));
    return t;
  };
  const read = async (commit: GitCommit) => {
    stopIfCancelled();
    // A shallow clone's boundary commit has no parent here, so its diff would add every file.
    if (shallow.has(commit.sha)) {
      skipped.shallow++;
      return [];
    }
    const changes = (await commitChanges(folder, commit.sha, run)).filter((c) => {
      if (filter(c.path)) return true;
      skipped.filtered++;
      return false;
    });
    return Promise.all(
      changes.map(async (change) => {
        stopIfCancelled();
        const [before, after] = await Promise.all([
          change.beforeSha === undefined ? EMPTY : textOf(change.path, change.beforeSha),
          change.afterSha === undefined ? EMPTY : textOf(change.path, change.afterSha),
        ]);
        return { commit, change, before, after };
      }),
    );
  };
  const changed: Awaited<ReturnType<typeof read>> = [];
  // A batch of commits at a time keeps git busy while cancelling stays prompt.
  for (let i = 0; i < commits.length; i += COMMIT_BATCH) {
    for (const r of await Promise.all(commits.slice(i, i + COMMIT_BATCH).map(read))) changed.push(...r);
  }
  stopIfCancelled();
  const events: NewChangeEvent[] = [];
  const commitOf: GitCommit[] = [];
  for (const { commit, change, before, after } of changed) {
    const failed = typeof before === 'string' ? before : typeof after === 'string' ? after : undefined;
    if (failed !== undefined) {
      skipped[failed]++;
      continue;
    }
    const b = before as Text;
    const a = after as Text;
    if (b.text === a.text) continue;
    const { added, removed } = countChanges(b.text, a.text);
    events.push({
      uri: uriOf(change.path),
      relPath: mirrorPathOf(change.path),
      time: commit.time,
      kind: change.kind,
      before: b.text,
      after: a.text,
      eol: change.kind === 'delete' ? b.eol : a.eol,
      linesAdded: added,
      linesRemoved: removed,
    });
    commitOf.push(commit);
  }
  return { commits, events, commitOf, skipped };
}

interface Text {
  text: string;
  eol: '\n' | '\r\n';
}

/** A blob's text, or why it has none. */
type BlobText = Text | 'binary' | 'tooLarge' | 'unreadable' | 'lfs';

const EMPTY: Text = { text: '', eol: '\n' };

async function readText(
  folder: string,
  path: string,
  sha: string,
  maxBytes: number,
  decode: (bytes: Uint8Array, path: string) => string | undefined,
  run: GitRunner,
): Promise<BlobText> {
  // The stored size first, so a large blob is never read; filters can still grow it.
  const size = await run(['cat-file', '-s', sha], folder).then(
    (out) => Number(out.toString('utf8').trim()),
    () => NaN,
  );
  if (Number.isNaN(size)) return 'unreadable';
  if (size > maxBytes) return 'tooLarge';
  const bytes = await readBlob(folder, path, sha, run);
  if (!bytes) return 'unreadable';
  if (bytes.byteLength > maxBytes) return 'tooLarge';
  if (looksBinary(bytes)) return 'binary';
  const raw = decode(bytes, path);
  if (raw === undefined || isBinaryText(raw)) return 'binary';
  if (LFS_POINTER.test(raw)) return 'lfs';
  return { text: normalizeEol(raw), eol: detectEol(raw) };
}

/** A branch by its full ref, which git reads unambiguously, and the short name shown for it. */
export interface Branch {
  ref: string;
  name: string;
}

/** Candidates for the default branch when the remote's HEAD is unknown, in order. */
const BASE_FALLBACKS = ['refs/remotes/origin/main', 'refs/remotes/origin/master', 'refs/heads/main', 'refs/heads/master'];

/** The branch a feature branch is compared with: the remote's default branch, else a usual name that exists. */
export async function defaultBase(folder: string, run: GitRunner = runReplayGit): Promise<Branch | undefined> {
  const remoteHead = await run(['symbolic-ref', '-q', 'refs/remotes/origin/HEAD'], folder).then(
    (out) => out.toString('utf8').trim(),
    () => '',
  );
  for (const ref of remoteHead ? [remoteHead, ...BASE_FALLBACKS] : BASE_FALLBACKS) {
    if (await isCommit(folder, ref, run)) return { ref, name: shortRef(ref) };
  }
  return undefined;
}

/** The checked-out branch's short name, or undefined when HEAD is detached. */
export async function currentBranch(folder: string, run: GitRunner = runReplayGit): Promise<string | undefined> {
  const out = await run(['symbolic-ref', '-q', '--short', 'HEAD'], folder).then(
    (o) => o.toString('utf8').trim(),
    () => '',
  );
  return out || undefined;
}

/** Local and remote-tracking branches, most recently committed first, without remote HEAD aliases. */
export async function listBranches(folder: string, run: GitRunner = runReplayGit): Promise<Branch[]> {
  const out = await git(run, folder, ['for-each-ref', '--sort=-committerdate', '--format=%(refname)', 'refs/heads', 'refs/remotes']);
  return out
    .split('\n')
    .filter((r) => r && !r.endsWith('/HEAD'))
    .map((ref) => ({ ref, name: shortRef(ref) }));
}

function shortRef(ref: string): string {
  return ref.replace(/^refs\/(heads|remotes)\//, '');
}

/** Commits a shallow clone lists as its boundary (their parents are not here), or none for a full clone. */
async function shallowCommits(folder: string, run: GitRunner): Promise<Set<string>> {
  try {
    const file = (await run(['rev-parse', '--git-path', 'shallow'], folder)).toString('utf8').trim();
    const text = await fsp.readFile(nodePath.resolve(folder, file), 'utf8');
    return new Set(text.split('\n').map((l) => l.trim()).filter(Boolean));
  } catch {
    return new Set();
  }
}

/** How many non-merge commits the revisions name. */
export async function countCommits(folder: string, revs: string[], run: GitRunner = runReplayGit): Promise<number> {
  return Number((await git(run, folder, ['rev-list', '--count', '--no-merges', ...revs, '--'])).trim());
}

/** True when the folder is inside a git work tree. */
export async function isRepository(folder: string, run: GitRunner = runReplayGit): Promise<boolean> {
  return run(['rev-parse', '--is-inside-work-tree'], folder).then(
    (out) => out.toString('utf8').trim() === 'true',
    () => false,
  );
}

async function isCommit(folder: string, ref: string, run: GitRunner): Promise<boolean> {
  return run(['rev-parse', '--verify', '-q', `${ref}^{commit}`], folder).then(
    () => true,
    () => false,
  );
}

/** Runs git and returns stdout as text; a failure becomes a GitReplayError with git's reason. */
async function git(run: GitRunner, folder: string, args: string[]): Promise<string> {
  try {
    return (await run(args, folder)).toString('utf8');
  } catch (err) {
    throw new GitReplayError(gitReason(err));
  }
}

/** git's `fatal:`/`error:` lines from a failed run's message, else its last line. */
export function gitReason(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  const lines = message.split('\n').map((l) => l.trim()).filter(Boolean);
  const reasons = lines.filter((l) => /^(fatal|error):/.test(l)).map((l) => l.replace(/^(fatal|error):\s*/, ''));
  return reasons.length > 0 ? reasons.join('; ') : (lines[lines.length - 1] ?? 'git failed');
}
