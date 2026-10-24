import * as vscode from 'vscode';
import * as os from 'node:os';
import * as path from 'node:path';
import { readHighlightSettings, readMirrorStatusRow, readSettings, setRepoValues, storedProfiles, updateSetting, workspaceOverrides, writesWorkspace, SECTION } from './config';
import { parseExtensionList, PathFilter, selectionGlob, stillFiltered } from './filter';
import { buildReplay, countCommits, currentBranch, defaultBase, isRepository, listBranches, resolveRange } from './gitReplay';
import { HighlightView } from './highlightView';
import { MirrorControls } from './mirrorControls';
import { MirrorFileSystem, MIRROR_SCHEME, mirrorBytes, SnapshotProvider, SNAPSHOT_SCHEME } from './mirrorFs';
import { sessionFromBytes, sessionToBytes, TimelineStore } from './persistence';
import { Player } from './player';
import { activeProfileOf, describeProfile, isValidProfileName } from './profiles';
import { Recorder, relPathOf, type CheckoutChoices, type CheckoutInfo, type FolderCheckouts } from './recorder';
import { CheckoutChoiceFile, checkoutName, folderCheckoutChoice, pathKey } from './worktrees';
import { scrubberState } from './scrubberState';
import { ScrubberView } from './scrubberView';
import { REPO_SETTINGS_FILE } from './repoSettings';
import { RepoSettingsFile } from './repoSettingsFile';
import { statusPresentation } from './statusText';
import { decodeBytes } from './textDecode';
import { Timeline, laneOf, sessionClears, sessionLanes, toSession, type LaneInfo } from './timeline';
import { ChangeItem, laneName, TimelineView } from './timelineView';
import { CheckoutRow, CheckoutsView, type FolderCheckoutsModel } from './checkoutsView';
import { LaneDecorations } from './laneDecorations';

/** Returned from activate so integration tests (or other extensions) can observe playback. */
export interface AgentTypewriterApi {
  timeline: Timeline;
  player: Player;
  recorder: Recorder;
  scrubber: ScrubberView;
  mirrorControls: MirrorControls;
  highlights: HighlightView;
  /** Undefined when no folder is open (no workspace storage). */
  store: TimelineStore | undefined;
  /** Re-reads each folder's checkouts, as a window focus does, and returns them by folder URI. For tests. */
  refreshCheckouts(): Promise<ReadonlyMap<string, Pick<CheckoutInfo, 'own' | 'name' | 'worktrees' | 'lanes'>>>;
  /** Closes mirror tabs whose file the mirror filesystem does not hold, as activation does once. Returns how many. For tests. */
  closeOrphanMirrorTabs(): Promise<number>;
  /** Settles once activation has refilled the mirrors from the restored timeline and closed orphaned mirror tabs. For tests. */
  mirrorRestore: Promise<{ refilled: number; closed: number }>;
}

/** Mirror reads wait at most this long for the restored timeline to refill them. */
const MIRROR_GATE_BACKSTOP_MS = 10_000;

/** Final save on deactivation, set while active. */
let finalSave: (() => void) | undefined;

export async function activate(context: vscode.ExtensionContext): Promise<AgentTypewriterApi> {
  const log = vscode.window.createOutputChannel('Agent Typewriter');
  const repoFile = new RepoSettingsFile(log);
  const timeline = new Timeline(readSettings().historyLimit);
  const mirror = new MirrorFileSystem();
  // Without a folder there is no workspace storage; choices then last for the session.
  const choices: CheckoutChoices = context.storageUri
    ? new CheckoutChoiceFile(path.join(context.storageUri.fsPath, 'checkouts.json'))
    : new Map<string, string>();
  const recorder = new Recorder(timeline, readSettings, log, choices);
  const player = new Player(timeline, mirror, readSettings, log);
  const highlights = new HighlightView(timeline, player, readHighlightSettings, context.extensionUri);
  const view = new TimelineView(timeline);
  const tree = vscode.window.createTreeView('agentTypewriter.timeline', { treeDataProvider: view });
  /** Every checkout of each folder, its own first, and the ones it records (or will once started). */
  const loadCheckouts = async (): Promise<FolderCheckoutsModel[]> => {
    const out: FolderCheckoutsModel[] = [];
    for (const folder of vscode.workspace.workspaceFolders ?? []) {
      const c = await recorder.checkoutsOf(folder);
      const live = recorder.recordedLanes().filter((l) => l.folder.uri.toString() === folder.uri.toString());
      const checkouts = c
        ? [
            { path: c.own?.path ?? folder.uri.fsPath, name: c.own ? checkoutName(c.own) : '', own: true },
            ...c.worktrees.filter((w) => w !== c.own).map((w) => ({ path: w.path, name: checkoutName(w), own: false })),
          ]
        : [{ path: folder.uri.fsPath, name: '', own: true }];
      out.push({ folder, checkouts, recorded: recorder.isRunning ? live.map((l) => l.checkout) : (c?.recorded ?? [folder.uri.fsPath]) });
    }
    return out;
  };
  const checkoutsView = new CheckoutsView(timeline, loadCheckouts, {
    add: (folder, p) => recorder.addCheckout(folder, p),
    remove: (folder, p) => recorder.removeCheckout(folder, p),
    error: (message) => void vscode.window.showErrorMessage(`Agent Typewriter: ${message}`),
  });
  const laneDecorations = new LaneDecorations(timeline);
  const checkoutsTree = vscode.window.createTreeView('agentTypewriter.checkouts', { treeDataProvider: checkoutsView, manageCheckboxStateManually: true });
  const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 50);
  const checkoutStatus = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 49);
  const playbackState = () =>
    scrubberState(timeline, { paused: player.isPaused, speed: player.speed, watching: recorder.isRunning, hasHighlights: highlights.hasHighlights });
  const scrubber = new ScrubberView(playbackState);
  const mirrorControls = new MirrorControls(player, playbackState, readMirrorStatusRow, () => timeline.all().length > 0);
  const store = context.storageUri
    ? new TimelineStore(context.storageUri.fsPath, timeline, (line) => log.appendLine(line))
    : undefined;

  context.subscriptions.push(
    log,
    repoFile,
    recorder,
    player,
    highlights,
    view,
    tree,
    checkoutsView,
    checkoutsTree,
    laneDecorations,
    checkoutsTree.onDidChangeCheckboxState(async (e) => {
      for (const [item, state] of e.items) {
        if (item instanceof CheckoutRow) await checkoutsView.setChecked(item, state === vscode.TreeItemCheckboxState.Checked);
      }
    }),
    status,
    checkoutStatus,
    scrubber,
    mirrorControls,
    vscode.window.registerWebviewViewProvider(ScrubberView.id, scrubber),
    vscode.languages.registerCodeLensProvider({ scheme: MIRROR_SCHEME }, mirrorControls),
    vscode.languages.registerHoverProvider({ scheme: MIRROR_SCHEME }, highlights),
    vscode.window.registerFileDecorationProvider(laneDecorations),
    { dispose: () => store?.dispose() },
    vscode.workspace.registerFileSystemProvider(MIRROR_SCHEME, mirror, { isCaseSensitive: true }),
    vscode.workspace.registerTextDocumentContentProvider(SNAPSHOT_SCHEME, new SnapshotProvider((seq) => timeline.get(seq))),
  );

  // ------------------------------------------------------------ status

  /**
   * The checkout each folder records (or will record once started), by folder
   * URI; only folders in git. `worktrees` counts the checkouts the chooser
   * offers: one more than git lists for a folder with no checkout of its own.
   */
  const checkouts = new Map<string, Pick<CheckoutInfo, 'own' | 'name' | 'worktrees' | 'lanes'>>();
  // Calls overlap (scope events, focus, folder changes); only the newest one's answer is kept.
  let checkoutsGen = 0;
  const refreshCheckouts = async (): Promise<ReadonlyMap<string, Pick<CheckoutInfo, 'own' | 'name' | 'worktrees' | 'lanes'>>> => {
    const gen = ++checkoutsGen;
    const next = new Map<string, Pick<CheckoutInfo, 'own' | 'name' | 'worktrees' | 'lanes'>>();
    for (const folder of vscode.workspace.workspaceFolders ?? []) {
      const c = await recorder.checkoutsOf(folder);
      const live = recorder.checkoutOf(folder);
      if (live) {
        // What is recorded comes from the recorder; the count from a fresh
        // listing, since worktrees added or removed elsewhere send no event.
        const worktrees = c ? folderCheckoutChoice(folder.name, c.own, c.worktrees).choices : live.worktrees + (live.container ? 1 : 0);
        if (worktrees > 0) next.set(folder.uri.toString(), { own: live.own, name: live.name, worktrees, lanes: live.lanes });
        continue;
      }
      if (!c) continue;
      const chosen = c.chosen !== undefined ? c.worktrees.find((w) => pathKey(w.path) === pathKey(c.chosen!)) : undefined;
      const choice = folderCheckoutChoice(folder.name, c.own, c.worktrees);
      const recorded = c.recorded.length;
      const first = recorded === 1 ? c.worktrees.find((w) => pathKey(w.path) === pathKey(c.recorded[0])) : undefined;
      const shown = chosen ?? (first !== c.own ? first : undefined);
      next.set(folder.uri.toString(), { own: !shown || shown === c.own, name: shown ? checkoutName(shown) : choice.name, worktrees: choice.choices, lanes: recorded });
    }
    if (gen !== checkoutsGen) return next;
    checkouts.clear();
    for (const [k, v] of next) checkouts.set(k, v);
    refreshStatus();
    await checkoutsView.reload();
    return next;
  };

  let lastDropped = 0;
  const refreshStatus = () => {
    const watching = recorder.isRunning;
    // While watching, the filter summary already names the profile.
    const s = watching ? undefined : readSettings();
    const shown = statusPresentation({
      watching,
      paused: player.isPaused,
      pending: timeline.pendingCount(),
      speed: player.speed,
      watchedCount: recorder.watchedCount,
      filter: recorder.describeFilter(),
      profile: s && activeProfileOf(s) ? s.activeProfile : '',
      checkouts: [...checkouts.values()],
    });
    if (shown.checkout) {
      checkoutStatus.text = shown.checkout.text;
      checkoutStatus.tooltip = shown.checkout.tooltip;
      checkoutStatus.command = 'agentTypewriter.chooseCheckout';
      checkoutStatus.show();
    } else {
      checkoutStatus.hide();
    }
    status.text = shown.text;
    status.tooltip = shown.tooltip;
    status.command = shown.command;
    status.show();
    scrubber.refresh();
    mirrorControls.refresh();
    tree.description = shown.description;
    if (timeline.droppedUnplayed > lastDropped) {
      lastDropped = timeline.droppedUnplayed;
      tree.message = `${lastDropped} queued change(s) were dropped because the buffer is full (historyLimit).`;
    } else if (timeline.droppedUnplayed === 0) {
      lastDropped = 0;
      tree.message = undefined;
    }
  };
  // The followed lane is remembered, so a reload follows it again once it records.
  let followedSaved = timeline.followed;
  const saveFollowed = () => {
    if (timeline.followed === followedSaved || timeline.lanesInBuffer().length === 0) return;
    followedSaved = timeline.followed;
    void Promise.resolve(choices.setFollowed?.(followedSaved)).catch(() => {});
    // The status bar names the followed lane's checkout.
    void refreshCheckouts();
  };
  context.subscriptions.push(
    timeline.onDidChange(refreshStatus),
    timeline.onDidChange(saveFollowed),
    highlights.onDidChangeHighlighted(refreshStatus),
    recorder.onDidChangeScope(() => void refreshCheckouts()),
    vscode.workspace.onDidChangeWorkspaceFolders(() => void refreshCheckouts()),
    // Worktrees made elsewhere (a sibling directory, or while stopped) send no event here.
    vscode.window.onDidChangeWindowState((w) => w.focused && void refreshCheckouts()),
  );
  refreshStatus();
  void refreshCheckouts();

  const setWatching = (on: boolean) => vscode.commands.executeCommand('setContext', 'agentTypewriter.watching', on);
  const setAutoFollowKey = () => vscode.commands.executeCommand('setContext', 'agentTypewriter.autoFollow', readSettings().autoFollow);
  void setAutoFollowKey();

  // ------------------------------------------------------------ commands

  const register = (id: string, fn: (...args: any[]) => unknown) =>
    context.subscriptions.push(
      vscode.commands.registerCommand(id, async (...args: any[]) => {
        try {
          await fn(...args);
        } catch (err) {
          vscode.window.showErrorMessage(`Agent Typewriter: ${err instanceof Error ? err.message : String(err)}`);
        } finally {
          refreshStatus();
        }
      }),
    );

  register('agentTypewriter.start', async () => {
    // The repository file has loaded once history is restored.
    await historyRestored;
    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Window, title: 'Agent Typewriter: snapshotting files' },
      () => recorder.start(),
    );
    // Stop may have run while the start was still snapshotting.
    await setWatching(recorder.isRunning);
    if (recorder.isRunning) {
      vscode.window.setStatusBarMessage(`Agent Typewriter: watching ${recorder.watchedCount} files (${recorder.describeFilter()})`, 4000);
    }
  });

  register('agentTypewriter.stop', async () => {
    recorder.stop();
    await setWatching(false);
  });

  register('agentTypewriter.togglePause', () => {
    player.togglePause();
  });

  // The two states of the mirror's play/pause button; a stale click never flips playback back.
  register('agentTypewriter.pause', () => player.setPaused(true));
  register('agentTypewriter.resume', () => player.setPaused(false));

  register('agentTypewriter.finishCurrent', () => player.finishCurrent());

  const catchUp = async () => {
    recorder.drainHeld();
    timeline.seekToEnd();
    await player.interrupt();
    await player.snapToLatest();
  };
  register('agentTypewriter.catchUp', catchUp);

  register('agentTypewriter.replayAll', async () => {
    if (timeline.all().length === 0) {
      vscode.window.showInformationMessage('Agent Typewriter: the buffer is empty.');
      return;
    }
    timeline.seekToStart();
    await player.interrupt();
    player.setPaused(false);
  });

  register('agentTypewriter.replayFrom', async (arg?: ChangeItem | number) => {
    const seq = typeof arg === 'number' ? arg : arg?.event.seq;
    if (seq === undefined) return;
    // A change in another lane is replayed in that lane, which is followed from then on.
    const event = timeline.get(seq);
    if (event) timeline.follow(laneOf(event));
    timeline.seek(seq);
    await player.interrupt();
    player.setPaused(false);
  });

  // Like replayFrom, but keeps the pause state; past the newest change it skips to latest.
  const seekTo = async (seq: number) => {
    const events = timeline.laneEvents();
    if (events.length === 0 || seq > events[events.length - 1].seq) {
      await catchUp();
      return;
    }
    timeline.seek(seq);
    await player.interrupt();
  };
  register('agentTypewriter.seek', async (seq?: number) => {
    if (typeof seq === 'number') await seekTo(seq);
  });

  // Drops the change being typed (or the next queued one) and moves on to the one after it.
  register('agentTypewriter.skipToNext', async () => {
    const current = (timeline.playing !== undefined ? timeline.get(timeline.playing) : undefined) ?? timeline.peek();
    await seekTo((current?.seq ?? timeline.cursor) + 1);
  });

  register('agentTypewriter.showDiff', async (arg?: ChangeItem) => {
    if (!arg) return;
    const e = arg.event;
    await vscode.commands.executeCommand(
      'vscode.diff',
      SnapshotProvider.uriFor(e.seq, 'before', e.fromRelPath ?? e.relPath),
      SnapshotProvider.uriFor(e.seq, 'after', e.relPath),
      `${e.fromRelPath !== undefined ? `${e.fromRelPath} \u2192 ` : ''}${e.relPath} (#${e.seq} ${e.kind})`,
      { preview: true },
    );
  });

  register('agentTypewriter.clearHighlights', () => timeline.clearHighlights());
  register('agentTypewriter.clearHighlightsInFile', (uri?: vscode.Uri) => {
    // From the title bar the button passes its editor's URI; from the palette, the active editor counts.
    const target = uri instanceof vscode.Uri ? uri : vscode.window.activeTextEditor?.document.uri;
    if (target?.scheme === MIRROR_SCHEME) timeline.clearHighlights(target.path.replace(/^\/+/, ''));
  });

  register('agentTypewriter.clear', async () => {
    // Held changes were recorded before the clear; without this they land after it.
    recorder.drainHeld();
    timeline.clear();
    await player.interrupt();
  });

  register('agentTypewriter.saveSession', async (target?: vscode.Uri) => {
    recorder.drainHeld();
    if (timeline.all().length === 0) {
      vscode.window.showInformationMessage('Agent Typewriter: the buffer is empty, nothing to save.');
      return;
    }
    // Default outside the workspace: a session saved there would be recorded as a change.
    const uri =
      target ??
      (await vscode.window.showSaveDialog({
        title: 'Agent Typewriter: save session',
        defaultUri: vscode.Uri.file(path.join(os.homedir(), `agent-typewriter-${fileStamp(new Date())}.json`)),
        filters: { 'Agent Typewriter session': ['json'] },
      }));
    if (!uri) return;
    const { session } = toSession(timeline);
    await vscode.workspace.fs.writeFile(uri, sessionToBytes(session, { gzip: false }));
    vscode.window.setStatusBarMessage(`Agent Typewriter: saved ${session.events.length} change(s) to ${uri.fsPath}`, 4000);
  });

  /**
   * When `count` changes from `name` exceed historyLimit: interactively, lets
   * the user raise the limit or keep the newest; otherwise warns that only the
   * newest are kept. False when the user cancels.
   */
  const fitHistoryLimit = async (count: number, name: string, interactive: boolean): Promise<boolean> => {
    const limit = readSettings().historyLimit;
    if (count <= limit) return true;
    const raise = `Raise historyLimit to ${count}`;
    const pick = interactive
      ? await vscode.window.showWarningMessage(`${name} has ${count} changes but historyLimit is ${limit}.`, { modal: true }, raise, `Load newest ${limit}`)
      : undefined;
    if (interactive && !pick) return false;
    if (pick === raise) {
      await updateSetting('historyLimit', count);
      timeline.setLimit(count);
    } else if (!interactive) {
      vscode.window.showWarningMessage(`Agent Typewriter: loaded the newest ${limit} of ${count} changes (historyLimit).`);
    }
    return true;
  };

  register('agentTypewriter.loadSession', async (target?: vscode.Uri) => {
    const interactive = !target;
    const uri =
      target ??
      (
        await vscode.window.showOpenDialog({
          title: 'Agent Typewriter: load session',
          defaultUri: vscode.Uri.file(os.homedir()),
          canSelectMany: false,
          filters: { 'Agent Typewriter session': ['json', 'gz'] },
        })
      )?.[0];
    if (!uri) return;
    const session = sessionFromBytes(await vscode.workspace.fs.readFile(uri));
    const name = uri.path.slice(uri.path.lastIndexOf('/') + 1);
    if (session.events.length === 0) throw new Error(`${name} holds no changes.`);
    recorder.drainHeld();
    if (interactive && timeline.all().length > 0) {
      const replace = 'Replace';
      const pick = await vscode.window.showWarningMessage(
        `Replace the ${timeline.all().length} recorded change(s) with the ${session.events.length} in ${name}?`,
        { modal: true },
        replace,
      );
      if (pick !== replace) return;
    }
    if (!(await fitHistoryLimit(session.events.length, name, interactive))) return;
    // Loaded sessions start paused at their first change; the user resumes when ready.
    player.setPaused(true);
    // Changes recorded while the prompts were open are replaced too.
    recorder.drainHeld();
    // Every lane starts at its first change; the lane followed when it was saved is followed again.
    timeline.restore(session.events, session.events[0].seq, undefined, { ...sessionLanes(session), cursors: undefined });
    await player.interrupt();
    player.forgetPlaybackMirror();
    log.appendLine(`Loaded ${timeline.all().length} change(s) from ${uri.fsPath}; playback paused.`);
    vscode.window.setStatusBarMessage(`Agent Typewriter: loaded ${timeline.all().length} change(s). Resume playback to start.`, 6000);
  });

  // The folder whose repository a git replay reads: by name or URI string, the only one, or picked.
  const gitReplayFolder = async (named?: string): Promise<vscode.WorkspaceFolder | undefined> => {
    const folders = (vscode.workspace.workspaceFolders ?? []).filter((f) => f.uri.scheme === 'file');
    if (named !== undefined) {
      const found = folders.find((f) => f.name === named || f.uri.toString() === named);
      if (!found) throw new Error(`no workspace folder ${named}.`);
      return found;
    }
    if (folders.length <= 1) {
      if (!folders[0]) throw new Error('open a folder in a git repository first.');
      return folders[0];
    }
    return vscode.window.showWorkspaceFolderPick({ placeHolder: 'Replay the git commits of which folder?' });
  };

  // What to replay: this branch or another one against the default branch, the last commit, or a typed range.
  // Branches go to git as full refs, so a tag or a local branch named like a remote one cannot shadow them.
  const pickGitRange = async (cwd: string): Promise<{ range: string; label: string } | undefined> => {
    const title = 'Agent Typewriter: replay git commits';
    const [base, branch] = await Promise.all([defaultBase(cwd), currentBranch(cwd)]);
    type Item = vscode.QuickPickItem & { range?: string; pick?: 'branch' | 'enter' };
    const items: Item[] = [];
    if (base) {
      const ahead = await countCommits(cwd, [`${base.ref}..HEAD`]).catch(() => 0);
      if (ahead > 0) {
        items.push({
          label: '$(git-branch) This branch',
          description: `${base.name}..HEAD`,
          detail: `${ahead} commit(s) on ${branch ?? 'HEAD'} that are not on ${base.name}`,
          range: `${base.ref}..HEAD`,
        });
      }
      items.push({ label: '$(git-pull-request) A branch...', description: `its commits that are not on ${base.name}`, pick: 'branch' });
    }
    items.push({ label: '$(git-commit) Last commit', description: 'HEAD', range: 'HEAD' });
    items.push({ label: '$(edit) Enter a commit or range...', description: 'main..feature, a1b2c3d, HEAD~5..HEAD', pick: 'enter' });
    const chosen = await vscode.window.showQuickPick(items, { title, placeHolder: 'Which commits? Merge commits are skipped.' });
    if (!chosen) return undefined;
    if (chosen.range) return { range: chosen.range, label: chosen.description ?? chosen.range };
    if (chosen.pick === 'branch' && base) {
      const branches = (await listBranches(cwd)).filter((b) => b.ref !== base.ref);
      const b = await vscode.window.showQuickPick(
        branches.map((x) => ({ label: x.name, ref: x.ref })),
        { title, placeHolder: `Replay a branch's commits that are not on ${base.name}` },
      );
      return b && { range: `${base.ref}..${b.ref}`, label: `${base.name}..${b.label}` };
    }
    const typed = await vscode.window.showInputBox({
      title,
      prompt: 'A commit, or a range in git syntax (base..head). Merge commits are skipped.',
      placeHolder: 'main..feature',
      validateInput: (v) => {
        try {
          resolveRange(v);
          return undefined;
        } catch (err) {
          return (err as Error).message;
        }
      },
    });
    return typed === undefined ? undefined : { range: typed, label: typed.trim() };
  };

  register('agentTypewriter.replayGit', async (arg?: { range?: string; folder?: string; play?: boolean }) => {
    const interactive = typeof arg?.range !== 'string';
    const folder = await gitReplayFolder(arg?.folder);
    if (!folder) return;
    const cwd = folder.uri.fsPath;
    if (!(await isRepository(cwd))) throw new Error(`${folder.name} is not in a git repository.`);
    const picked = interactive ? await pickGitRange(cwd) : { range: arg!.range!, label: arg!.range! };
    if (!picked) return;
    const { label: range } = picked;
    const revs = resolveRange(picked.range);
    const s = readSettings();
    const filter = new PathFilter(s);
    let cancelled = false;
    const replay = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: `Agent Typewriter: reading ${range}`, cancellable: true },
      (_progress, token) => {
        token.onCancellationRequested(() => (cancelled = true));
        return buildReplay(cwd, revs, {
          filter: (p) => filter.matches(p),
          maxBytes: s.maxFileSizeKB * 1024,
          decode: (bytes, p) => decodeBytes(bytes, vscode.workspace.getConfiguration('files', vscode.Uri.joinPath(folder.uri, p)).get<string>('encoding')),
          uriOf: (p) => vscode.Uri.joinPath(folder.uri, p).toString(),
          // The folder's own mirror path, as the recorder names it (with the folder's label in a multi-root workspace).
          mirrorPathOf: (p) => recorder.mirrorPathOf(vscode.Uri.joinPath(folder.uri, p)),
          isCancelled: () => token.isCancellationRequested,
        }).catch((err: unknown) => {
          if (token.isCancellationRequested) return undefined;
          throw err;
        });
      },
    );
    // A cancel the build no longer checked for (its last git calls were running) still cancels.
    if (!replay || cancelled) return;
    const { events, skipped } = replay;
    const skips = Object.entries({
      filtered: skipped.filtered,
      binary: skipped.binary,
      'too large': skipped.tooLarge,
      unreadable: skipped.unreadable,
      'in Git LFS': skipped.lfs,
    })
      .filter(([, n]) => n > 0)
      .map(([why, n]) => `${n} ${why}`);
    if (skipped.shallow > 0) skips.push(`${skipped.shallow} shallow-clone boundary commit(s)`);
    const skipNote = skips.length > 0 ? ` (skipped ${skips.join(', ')})` : '';
    if (events.length === 0) {
      vscode.window.showInformationMessage(`Agent Typewriter: ${range} has no file changes to replay${skipNote}.`);
      return;
    }
    recorder.drainHeld();
    const commits = new Set(replay.commitOf).size;
    if (interactive && (timeline.all().length > 0 || recorder.isRunning)) {
      const effects = [
        ...(timeline.all().length > 0 ? [`replaces the ${timeline.all().length} recorded change(s)`] : []),
        ...(recorder.isRunning ? ['stops watching'] : []),
      ];
      const replayIt = 'Replay';
      const pick = await vscode.window.showWarningMessage(
        `Replay ${events.length} change(s) from ${commits} commit(s)? This ${effects.join(' and ')}.`,
        { modal: true },
        replayIt,
      );
      if (pick !== replayIt) return;
    }
    if (!(await fitHistoryLimit(events.length, range, interactive))) return;
    // Paused before stopping: stopping adds held live changes, which must not start typing.
    player.setPaused(true);
    // Live edits would start from the disk, not from the replayed history.
    if (recorder.isRunning) {
      recorder.stop();
      await setWatching(false);
    }
    timeline.restore(
      events.map((e, i) => ({ ...e, seq: i + 1 })),
      1,
    );
    await player.interrupt();
    player.forgetPlaybackMirror();
    // Picking the range is the cue to play; a scripted replay starts paused unless it asks to play.
    const play = interactive || arg?.play === true;
    // historyLimit may have kept only the newest changes.
    const kept = timeline.all().length;
    const keptCommits = new Set(replay.commitOf.slice(replay.commitOf.length - kept));
    log.appendLine(`Replaying ${kept} change(s) from ${keptCommits.size} commit(s) of ${range} in ${folder.name}${skipNote}${play ? '' : '; playback paused'}.`);
    for (const c of keptCommits) log.appendLine(`  ${c.sha.slice(0, 7)} ${c.subject}`);
    vscode.window.setStatusBarMessage(
      `Agent Typewriter: ${kept} change(s) from ${keptCommits.size} commit(s)${skipNote}.${play ? '' : ' Resume playback to start.'}`,
      6000,
    );
    if (play) player.setPaused(false);
  });

  register('agentTypewriter.setExtensions', async () => {
    const current = readSettings().extensions.join(', ');
    const input = await vscode.window.showInputBox({
      title: 'Agent Typewriter: watched extensions',
      prompt: 'Comma or space separated, e.g. "ts tsx java md". Leave empty to watch every extension.',
      value: current,
    });
    if (input === undefined) return;
    await updateSetting('extensions', parseExtensionList(input));
  });

  /** The Explorer selection with its include glob; only files can still be filtered out by other rules. */
  const selectionOf = async (uris: vscode.Uri[]) => {
    const picked: Array<{ uri: vscode.Uri; glob: string; isFile: boolean }> = [];
    for (const uri of uris) {
      // asRelativePath gives a workspace folder root as an absolute path.
      const isRoot = (vscode.workspace.workspaceFolders ?? []).some((f) => f.uri.toString() === uri.toString());
      const isDir = isRoot || ((await vscode.workspace.fs.stat(uri)).type & vscode.FileType.Directory) !== 0;
      picked.push({ uri, glob: selectionGlob(isRoot ? undefined : relPathOf(uri), isDir), isFile: !isDir });
    }
    return picked;
  };

  const warnIfStillFiltered = (picked: Array<{ uri: vscode.Uri; isFile: boolean }>) => {
    const s = readSettings();
    const blocked = stillFiltered(new PathFilter(s), picked.map((p) => ({ rel: relPathOf(p.uri), isFile: p.isFile })));
    if (blocked?.by === 'extension') {
      void vscode.window
        .showWarningMessage(
          `Agent Typewriter: ${blocked.rel} is still filtered out by the extension list (${s.extensions.join(', ')}).`,
          'Clear Extension Filter',
        )
        .then((pick) => pick && updateSetting('extensions', []));
    } else if (blocked?.by === 'exclude') {
      void vscode.window.showWarningMessage(`Agent Typewriter: ${blocked.rel} is still filtered out by the exclude list (${s.exclude.join(', ')}).`);
    }
  };

  register('agentTypewriter.watchOnlyThis', async (clicked?: vscode.Uri, selected?: vscode.Uri[]) => {
    const uris = selected?.length ? selected : clicked ? [clicked] : [];
    if (uris.length === 0) return;
    const picked = await selectionOf(uris);
    await updateSetting('include', picked.map((p) => p.glob));
    warnIfStillFiltered(picked);
  });

  register('agentTypewriter.addToWatch', async (clicked?: vscode.Uri, selected?: vscode.Uri[]) => {
    const uris = selected?.length ? selected : clicked ? [clicked] : [];
    if (uris.length === 0) return;
    const picked = await selectionOf(uris);
    const existing = readSettings().include.filter((g) => g !== '**/*' && g !== '**');
    const merged = [...new Set([...existing, ...picked.map((p) => p.glob)])];
    await updateSetting('include', merged);
    warnIfStillFiltered(picked);
  });

  register('agentTypewriter.resetFilters', async () => {
    await updateSetting('include', undefined);
    await updateSetting('exclude', undefined);
    await updateSetting('extensions', undefined);
  });

  register('agentTypewriter.switchProfile', async (arg?: unknown) => {
    await repoFile.ready;
    let s = readSettings();
    let name = typeof arg === 'string' ? arg : undefined;
    if (name === undefined) {
      const current = (n: string) => (n === s.activeProfile ? 'current' : undefined);
      const pick = await vscode.window.showQuickPick(
        [
          { label: 'No profile', name: '', description: current('') },
          ...Object.entries(s.profiles).map(([n, p]) => ({ label: n, name: n, description: current(n), detail: describeProfile(p) })),
        ],
        { title: 'Agent Typewriter: filter profile' },
      );
      if (!pick) return;
      name = pick.name;
    }
    if (name !== '' && !Object.hasOwn(s.profiles, name)) {
      // The repository file may have just been written; read it before giving up.
      await repoFile.reload();
      s = readSettings();
      if (!Object.hasOwn(s.profiles, name)) throw new Error(`No filter profile named "${name}".`);
    }
    // Activate first, so the filter never passes through a wider state while
    // values are cleared below.
    await updateSetting('activeProfile', name);
    // Workspace values the profile sets would hide it, so clear them. Without a
    // folder, settings are written to user settings, which already sit below the profile.
    if (name !== '' && writesWorkspace()) {
      for (const key of Object.keys(s.profiles[name])) await updateSetting(key, undefined);
    }
  });

  register('agentTypewriter.saveProfile', async (arg?: unknown) => {
    const name = (
      typeof arg === 'string'
        ? arg
        : await vscode.window.showInputBox({
            title: 'Agent Typewriter: save filters as profile',
            prompt: 'Profile name, for example "backend" or "docs"',
            validateInput: (v) => (isValidProfileName(v.trim()) ? undefined : 'Enter a name other than __proto__'),
          })
    )?.trim();
    if (name === undefined || name === '') return;
    if (!isValidProfileName(name)) throw new Error(`"${name}" cannot be used as a profile name.`);
    await repoFile.ready;
    const existing = storedProfiles();
    if (Object.hasOwn(existing, name)) {
      const ok = await vscode.window.showWarningMessage(`Replace the filter profile "${name}"?`, { modal: true }, 'Replace');
      if (ok !== 'Replace') return;
    }
    const { include, exclude, extensions, respectGitignore } = readSettings();
    await updateSetting('profiles', { ...existing, [name]: { include, exclude, extensions, respectGitignore } });
    await updateSetting('activeProfile', name);
  });

  register('agentTypewriter.openRepoSettings', async () => {
    const uri = repoFile.uri;
    if (!uri) throw new Error('Open a folder or workspace first.');
    const exists = await vscode.workspace.fs.stat(uri).then(
      () => true,
      () => false,
    );
    if (exists) {
      await vscode.window.showTextDocument(uri);
      return;
    }
    // An untitled editor bound to the path: the user's own save creates the file.
    const doc = await vscode.workspace.openTextDocument(uri.with({ scheme: 'untitled' }));
    const editor = await vscode.window.showTextDocument(doc);
    if (doc.getText() === '') {
      const { include, exclude, extensions } = readSettings();
      const text = JSON.stringify({ include, exclude, extensions }, null, 2) + '\n';
      await editor.edit((b) => b.insert(new vscode.Position(0, 0), text));
    }
  });

  // Tests pass (folder, worktree path); an empty or null path means the folder's own checkout.
  register('agentTypewriter.chooseCheckout', async (folderArg?: vscode.Uri | string, pathArg?: string | null) => {
    const folders = vscode.workspace.workspaceFolders ?? [];
    if (folders.length === 0) throw new Error('Open a folder or workspace first.');
    const only = folderArg ? vscode.workspace.getWorkspaceFolder(typeof folderArg === 'string' ? vscode.Uri.file(folderArg) : folderArg) : undefined;
    if (folderArg && !only) throw new Error(`${String(folderArg)} is not in a workspace folder.`);
    const candidates: Array<[vscode.WorkspaceFolder, FolderCheckouts]> = [];
    for (const folder of only ? [only] : folders) {
      const c = await recorder.checkoutsOf(folder);
      if (c && (folderCheckoutChoice(folder.name, c.own, c.worktrees).choices > 1 || pathArg !== undefined)) candidates.push([folder, c]);
    }
    if (candidates.length === 0) {
      const which = only?.name ?? (folders.length === 1 ? folders[0].name : undefined);
      vscode.window.showInformationMessage(
        which ? `Agent Typewriter: ${which} has no other checkouts.` : 'Agent Typewriter: no workspace folder has other checkouts.',
      );
      return;
    }
    let target = candidates[0];
    if (candidates.length > 1) {
      const pick = await vscode.window.showQuickPick(
        candidates.map(([folder, c]) => ({ label: folder.name, detail: `${folderCheckoutChoice(folder.name, c.own, c.worktrees).choices} checkouts`, entry: [folder, c] as const })),
        { title: 'Agent Typewriter: choose a checkout for which folder?' },
      );
      if (!pick) return;
      target = [pick.entry[0], pick.entry[1]];
    }
    const [folder, c] = target;
    if (pathArg !== undefined) {
      await recorder.setCheckout(folder, pathArg || undefined);
      return;
    }
    const current = pathKey(c.chosen ?? c.own?.path ?? folder.uri.fsPath);
    const mark = (p: string) => (pathKey(p) === current ? 'current' : undefined);
    const others = c.worktrees.filter((w) => w !== c.own);
    const self = folderCheckoutChoice(folder.name, c.own, c.worktrees);
    const pick = await vscode.window.showQuickPick(
      [
        {
          label: self.label,
          description: [self.description, mark(c.own?.path ?? folder.uri.fsPath)].filter(Boolean).join(' · '),
          detail: c.own?.path ?? folder.uri.fsPath,
          path: undefined as string | undefined,
        },
        ...others.map((w) => ({ label: checkoutName(w), description: mark(w.path), detail: w.path, path: w.path as string | undefined })),
      ],
      { title: `Agent Typewriter: record which checkout of ${folder.name}?` },
    );
    if (!pick) return;
    await recorder.setCheckout(folder, pick.path);
  });

  // From a view row (its lane, or the lane id) or the palette, which asks.
  register('agentTypewriter.followLane', async (arg?: string | { lane: string | LaneInfo }) => {
    let lane = typeof arg === 'string' ? arg : typeof arg?.lane === 'string' ? arg.lane : arg?.lane?.id;
    const lanes = timeline.laneList();
    if (lane === undefined) {
      if (lanes.length < 2) {
        vscode.window.showInformationMessage('Agent Typewriter: there is only one lane to follow.');
        return;
      }
      const pick = await vscode.window.showQuickPick(
        lanes.map((l) => ({
          label: laneName(l),
          description: [`${timeline.pendingCount(l.id)} queued`, l.id === timeline.followed ? 'following' : '', l.recording ? '' : 'stopped']
            .filter(Boolean)
            .join(' · '),
          detail: l.root || undefined,
          lane: l.id,
        })),
        { title: 'Agent Typewriter: follow which lane?' },
      );
      if (!pick) return;
      lane = pick.lane;
    }
    if (!lanes.some((l) => l.id === lane)) {
      vscode.window.showWarningMessage('Agent Typewriter: that checkout has no lane yet. Record it first.');
      return;
    }
    if (lane === timeline.followed) return;
    timeline.follow(lane);
    await player.interrupt();
  });
  register('agentTypewriter.autoFollowOn', () => updateSetting('autoFollow', true));
  register('agentTypewriter.autoFollowOff', () => updateSetting('autoFollow', false));
  register('agentTypewriter.refreshCheckouts', () => refreshCheckouts());

  register('agentTypewriter.setSpeed', async (multiplier?: number) => {
    if (typeof multiplier === 'number' && Number.isFinite(multiplier) && multiplier > 0) {
      player.setSpeed(multiplier);
      return;
    }
    const options = [0.5, 1, 1.5, 2, 3, 5].map((m) => ({
      label: `${m}x`,
      description: m === player.speed ? 'current' : undefined,
      multiplier: m,
    }));
    const pick = await vscode.window.showQuickPick(
      [...options, { label: 'Base speed...', description: `${readSettings().charsPerMinute} chars/min setting`, multiplier: 0 }],
      { title: 'Agent Typewriter: playback speed (catch-up acceleration still applies on top)' },
    );
    if (!pick) return;
    if (pick.multiplier > 0) {
      player.setSpeed(pick.multiplier);
      return;
    }
    const input = await vscode.window.showInputBox({
      title: 'Base typing speed (characters per minute)',
      value: String(readSettings().charsPerMinute),
      validateInput: (v) => (Number(v) > 0 ? undefined : 'Enter a positive number'),
    });
    if (input) await updateSetting('charsPerMinute', Number(input));
  });

  // ------------------------------------------------------------ settings

  /** The unknown name last logged, so startup and the file's first load don't log it twice. */
  let loggedUnknown = '';
  const noteUnknownProfile = () => {
    const s = readSettings();
    const unknown = s.activeProfile !== '' && !Object.hasOwn(s.profiles, s.activeProfile) ? s.activeProfile : '';
    if (unknown !== '' && unknown !== loggedUnknown) {
      log.appendLine(`activeProfile "${unknown}" names no filter profile; filters apply without one.`);
    }
    loggedUnknown = unknown;
  };

  /** Whether the deprecation note is showing for the current settings, so it is written once each time it applies. */
  let loggedDeprecatedSpeed = false;
  const noteDeprecatedSpeed = () => {
    const deprecated = readSettings().speedFromDeprecatedSetting;
    if (deprecated && !loggedDeprecatedSpeed) {
      log.appendLine('charsPerSecond is deprecated; the base speed comes from it times 60. Set charsPerMinute instead.');
    }
    loggedDeprecatedSpeed = deprecated;
  };

  /** Applies a change to the given settings, whether it came from VS Code settings or the repository file. */
  const applySettingsChange = async (affects: (key: string) => boolean) => {
    if (affects('historyLimit')) timeline.setLimit(readSettings().historyLimit);
    if (affects('profiles') || affects('activeProfile')) noteUnknownProfile();
    if (affects('charsPerMinute') || affects('charsPerSecond')) noteDeprecatedSpeed();
    if (['include', 'exclude', 'extensions', 'respectGitignore', 'profiles', 'activeProfile'].some(affects)) {
      await recorder.refreshFilter();
    } else if (affects('autoRecordWorktrees')) {
      await recorder.refreshFilter('autoRecordWorktrees changed');
    }
    if (['gitBaselines', 'baselineBudgetMB', 'maxFileSizeKB'].some(affects)) await recorder.refreshBaselines();
    if (affects('persistHistory')) applyPersistHistory();
    if (affects('highlightAdditions') || affects('markDeletions')) highlights.refresh();
    if (affects('autoFollow')) await setAutoFollowKey();
    refreshStatus();
  };

  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration(async (e) => {
      if (!e.affectsConfiguration(SECTION)) return;
      await applySettingsChange((key) => e.affectsConfiguration(`${SECTION}.${key}`));
    }),
    repoFile.onDidChange(async (changed) => {
      setRepoValues(repoFile.values);
      // profiles merge by name instead of being overridden.
      const overridden = workspaceOverrides(Object.keys(repoFile.values).filter((k) => k !== 'profiles'));
      if (overridden.length > 0) {
        log.appendLine(`Workspace settings override ${REPO_SETTINGS_FILE} for: ${overridden.join(', ')}.`);
      }
      await applySettingsChange((key) => changed.includes(key));
    }),
  );

  // ------------------------------------------------------------ history

  // False until the saved timeline has been restored (or deleted), so a
  // settings change cannot start the store and overwrite it first.
  let historyLoaded = false;
  const applyPersistHistory = () => {
    if (!store || !historyLoaded) return;
    if (readSettings().persistHistory) store.start();
    else if (store.isRunning) {
      store.stop();
      store.deleteSaved();
    }
  };
  // Restore before anything can record, and once the repository file has
  // loaded: its historyLimit and persistHistory decide what is kept. The file's
  // change handler above has applied them by the time `ready` settles. The
  // player is waiting on the empty timeline, so pausing it first means restored
  // queued changes are not typed until the user resumes.
  const historyRestored = repoFile.ready.then(() => {
    if (store && readSettings().persistHistory) {
      const saved = store.load();
      if (saved && saved.events.length > 0) {
        const pending = saved.events.filter((e) => e.seq >= (saved.cursors?.[laneOf(e)] ?? saved.cursor)).length;
        if (pending > 0) player.setPaused(true);
        timeline.restore(saved.events, saved.cursor, sessionClears(saved), sessionLanes(saved));
        const queued = timeline.pendingCount();
        log.appendLine(`Restored ${timeline.all().length} change(s) from the last session${queued ? `; ${queued} queued, playback paused` : ''}.`);
        refreshStatus();
      }
    } else if (store) {
      store.deleteSaved();
    }
    historyLoaded = true;
    applyPersistHistory();
  });
  // Mirror files live in memory, so after a restart the tabs VS Code reopens
  // have nothing behind them. Refill each recorded file's mirror from the
  // restored timeline, then let reads through; the backstop lets them through
  // if the restore stalls, and the refill still reloads those tabs later.
  // Mirror tabs left with no file, plain or in a diff, are closed once.
  const isOrphan = (uri: vscode.Uri) => uri.scheme === MIRROR_SCHEME && !mirror.has(uri);
  const closeOrphanMirrorTabs = async (): Promise<number> => {
    const orphans = vscode.window.tabGroups.all
      .flatMap((g) => g.tabs)
      .filter((t) =>
        t.input instanceof vscode.TabInputText
          ? isOrphan(t.input.uri)
          : t.input instanceof vscode.TabInputTextDiff && (isOrphan(t.input.original) || isOrphan(t.input.modified)),
      );
    if (orphans.length === 0) return 0;
    await vscode.window.tabGroups.close(orphans);
    log.appendLine(`Closed ${orphans.length} mirror tab(s) with no recorded history.`);
    return orphans.length;
  };
  const backstop = setTimeout(() => mirror.open(), MIRROR_GATE_BACKSTOP_MS);
  context.subscriptions.push({
    dispose: () => {
      clearTimeout(backstop);
      mirror.open();
    },
  });
  let refilled = 0;
  const mirrorsRefilled = historyRestored
    .catch(() => undefined)
    .then(() => {
      clearTimeout(backstop);
      refilled = mirror.seed(
        [...timeline.mirrorStates()].map(([rel, { text, eol }]) => [MirrorFileSystem.uriFor(rel), mirrorBytes(text, eol)]),
      );
      if (refilled) log.appendLine(`Refilled ${refilled} mirror file(s) from the restored timeline.`);
    })
    .finally(() => mirror.open());
  const mirrorRestore = mirrorsRefilled.then(async () => {
    const closed = await closeOrphanMirrorTabs().catch((err) => {
      log.appendLine(`Could not close mirror tabs with no history: ${err}`);
      return 0;
    });
    return { refilled, closed };
  });

  finalSave = () => {
    recorder.drainHeld();
    if (store?.isRunning) store.flushSync();
  };
  context.subscriptions.push({ dispose: () => (finalSave = undefined) });

  void setWatching(false);
  await historyRestored;
  await mirrorsRefilled;
  noteUnknownProfile();
  noteDeprecatedSpeed();
  if (readSettings().autoStart && vscode.workspace.workspaceFolders?.length) {
    void vscode.commands.executeCommand('agentTypewriter.start');
  }
  return { timeline, player, recorder, store, scrubber, refreshCheckouts, mirrorControls, highlights, closeOrphanMirrorTabs, mirrorRestore };
}

/** Local time as yyyy-mm-dd-hhmm, for default session file names. */
function fileStamp(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`;
}

export function deactivate(): void {
  // Save before the disposables run, with every held change in the timeline.
  // Disposables registered on the context clean up the rest.
  finalSave?.();
}
