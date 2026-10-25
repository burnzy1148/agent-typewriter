/**
 * Lane policy, kept pure so it is tested without VS Code: how many checkouts
 * record at once, which color a lane gets, which lane rotation stops for a new
 * worktree, and which lane auto-follow moves to.
 */

/** Most checkouts that record at once, across every workspace folder. */
export const MAX_LANES = 5;
/** Number of lane colors; with more lanes in the buffer, colors repeat. */
export const LANE_COLORS = 5;
/** A lane must have recorded nothing for this long before rotation may stop it. */
export const ROTATE_IDLE_MS = 120_000;
/** How long the followed lane must be caught up and quiet before auto-follow moves on. */
export const AUTO_FOLLOW_IDLE_MS = 3000;

/** What the policy needs to know about one lane. */
export interface LaneActivity {
  id: string;
  /** Still recording, as opposed to stopped with its changes kept. */
  recording: boolean;
  /** Epoch millis of its newest change, or when it started recording if it has none. */
  lastActivity: number;
  /** Seq of its oldest pending change, if any is pending. */
  firstPendingSeq?: number;
}

/**
 * The color slot (1..LANE_COLORS) for a new lane: its remembered slot while no
 * other lane holds it, else the least used slot, lowest first.
 */
export function colorSlot(remembered: number | undefined, taken: readonly number[]): number {
  const uses = (slot: number) => taken.filter((t) => t === slot).length;
  if (remembered !== undefined && remembered >= 1 && remembered <= LANE_COLORS && uses(remembered) === 0) return remembered;
  let best = 1;
  for (let slot = 2; slot <= LANE_COLORS; slot++) if (uses(slot) < uses(best)) best = slot;
  return best;
}

/**
 * The lane rotation stops to make room: the recording, unfollowed lane whose
 * newest change is oldest, among those idle at least ROTATE_IDLE_MS.
 */
export function rotationVictim(lanes: readonly LaneActivity[], followed: string | undefined, now: number): string | undefined {
  let victim: LaneActivity | undefined;
  for (const lane of lanes) {
    if (!lane.recording || lane.id === followed || now - lane.lastActivity < ROTATE_IDLE_MS) continue;
    if (!victim || lane.lastActivity < victim.lastActivity) victim = lane;
  }
  return victim?.id;
}

/** The lane auto-follow moves to: the one, other than `followed`, whose oldest pending change was recorded first. */
export function autoFollowTarget(lanes: readonly LaneActivity[], followed: string | undefined): string | undefined {
  let target: LaneActivity | undefined;
  for (const lane of lanes) {
    if (lane.id === followed || lane.firstPendingSeq === undefined) continue;
    if (!target || lane.firstPendingSeq < target.firstPendingSeq!) target = lane;
  }
  return target?.id;
}

/**
 * What auto-follow does now: follow another lane once the followed one has
 * nothing queued, nothing is being typed, and it has been quiet since
 * `quietSince` for AUTO_FOLLOW_IDLE_MS; or check again in `checkIn` ms.
 */
export function autoFollowDecision(s: {
  enabled: boolean;
  playing: boolean;
  followed: string;
  lanes: readonly LaneActivity[];
  quietSince: number;
  now: number;
}): { follow?: string; checkIn?: number } {
  if (!s.enabled || s.playing) return {};
  if (s.lanes.find((l) => l.id === s.followed)?.firstPendingSeq !== undefined) return {};
  const target = autoFollowTarget(s.lanes, s.followed);
  if (target === undefined) return {};
  const wait = s.quietSince + AUTO_FOLLOW_IDLE_MS - s.now;
  return wait > 0 ? { checkIn: wait } : { follow: target };
}

/** A lane's label: its branch or short commit, or the folder name outside git, with the folder name added in a multi-root workspace. */
export function laneLabel(checkoutName: string, folderName: string, multiRoot: boolean): string {
  if (!checkoutName) return folderName;
  return multiRoot ? `${checkoutName} (${folderName})` : checkoutName;
}

/** A two-character badge for a lane's mirror tabs: initials of its label's words, or its first two letters. */
export function laneBadge(label: string): string {
  const words = label.split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  if (words.length === 0) return '?';
  const initials = words.length > 1 ? [...words[0]][0] + [...words[1]][0] : [...words[0]].slice(0, 2).join('');
  // Upper case can grow a letter ('ß' to 'SS'); VS Code drops a badge longer than two characters.
  return [...initials.toUpperCase()].slice(0, 2).join('');
}

/** Which workspace folders record their own checkout by default: the first MAX_LANES, and the names of the rest. */
export function defaultLanes<T>(folders: readonly T[]): { recorded: T[]; left: T[] } {
  return { recorded: folders.slice(0, MAX_LANES), left: folders.slice(MAX_LANES) };
}
