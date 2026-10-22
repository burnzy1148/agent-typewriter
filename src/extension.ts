import * as vscode from 'vscode';
import * as os from 'node:os';
import * as path from 'node:path';
import { readSettings, setRepoValues, storedProfiles, updateSetting, workspaceOverrides, writesWorkspace, SECTION } from './config';
import { parseExtensionList, PathFilter, selectionGlob, stillFiltered } from './filter';
import { MirrorControls } from './mirrorControls';
import { MirrorFileSystem, MIRROR_SCHEME, SnapshotProvider, SNAPSHOT_SCHEME } from './mirrorFs';
import { sessionFromBytes, sessionToBytes, TimelineStore } from './persistence';
import { Player } from './player';
import { activeProfileOf, describeProfile, isValidProfileName } from './profiles';
import { Recorder, relPathOf, type CheckoutChoices, type CheckoutInfo, type FolderCheckouts } from './recorder';
import { CheckoutChoiceFile, checkoutName, pathKey } from './worktrees';
import { scrubberState } from './scrubberState';
import { ScrubberView } from './scrubberView';
import { REPO_SETTINGS_FILE } from './repoSettings';
import { RepoSettingsFile } from './repoSettingsFile';
import { statusPresentation } from './statusText';
import { Timeline, toSession } from './timeline';
import { ChangeItem, TimelineView } from './timelineView';

/** Returned from activate so integration tests (or other extensions) can observe playback. */
export interface AgentTypewriterApi {
  timeline: Timeline;
  player: Player;
  recorder: Recorder;
  scrubber: ScrubberView;
  mirrorControls: MirrorControls;
  /** Undefined when no folder is open (no workspace storage). */
  store: TimelineStore | undefined;
  /** Re-reads each folder's checkouts, as a window focus does, and returns them by folder URI. For tests. */
  refreshCheckouts(): Promise<ReadonlyMap<string, Pick<CheckoutInfo, 'own' | 'name' | 'worktrees'>>>;
}

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
  const view = new TimelineView(timeline);
  const tree = vscode.window.createTreeView('agentTypewriter.timeline', { treeDataProvider: view });
  const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 50);
  const checkoutStatus = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 49);
  const playbackState = () =>
    scrubberState(timeline, { paused: player.isPaused, speed: player.speed, watching: recorder.isRunning });
  const scrubber = new ScrubberView(playbackState);
  const mirrorControls = new MirrorControls(player, playbackState, () => readSettings().mirrorStatusRow);
  const store = context.storageUri
    ? new TimelineStore(context.storageUri.fsPath, timeline, (line) => log.appendLine(line))
    : undefined;

  context.subscriptions.push(
    log,
    repoFile,
    recorder,
    player,
    view,
    tree,
    status,
    checkoutStatus,
    scrubber,
    mirrorControls,
    vscode.window.registerWebviewViewProvider(ScrubberView.id, scrubber),
    vscode.languages.registerCodeLensProvider({ scheme: MIRROR_SCHEME }, mirrorControls),
    { dispose: () => store?.dispose() },
    vscode.workspace.registerFileSystemProvider(MIRROR_SCHEME, mirror, { isCaseSensitive: true }),
    vscode.workspace.registerTextDocumentContentProvider(SNAPSHOT_SCHEME, new SnapshotProvider((seq) => timeline.get(seq))),
  );

  // ------------------------------------------------------------ status

  /** The checkout each folder records (or will record once started), by folder URI; only folders in git. */
  const checkouts = new Map<string, Pick<CheckoutInfo, 'own' | 'name' | 'worktrees'>>();
  // Calls overlap (scope events, focus, folder changes); only the newest one's answer is kept.
  let checkoutsGen = 0;
  const refreshCheckouts = async (): Promise<ReadonlyMap<string, Pick<CheckoutInfo, 'own' | 'name' | 'worktrees'>>> => {
    const gen = ++checkoutsGen;
    const next = new Map<string, Pick<CheckoutInfo, 'own' | 'name' | 'worktrees'>>();
    for (const folder of vscode.workspace.workspaceFolders ?? []) {
      const c = await recorder.checkoutsOf(folder);
      const live = recorder.checkoutOf(folder);
      if (live) {
        // What is recorded comes from the recorder; the count from a fresh
        // listing, since worktrees added or removed elsewhere send no event.
        const worktrees = c?.worktrees.length ?? live.worktrees;
        if (worktrees > 0) next.set(folder.uri.toString(), { own: live.own, name: live.name, worktrees });
        continue;
      }
      if (!c) continue;
      const chosen = c.chosen !== undefined ? c.worktrees.find((w) => pathKey(w.path) === pathKey(c.chosen!)) : undefined;
      const shown = chosen ?? c.own;
      next.set(folder.uri.toString(), { own: !chosen || chosen === c.own, name: shown ? checkoutName(shown) : '', worktrees: c.worktrees.length });
    }
    if (gen !== checkoutsGen) return next;
    checkouts.clear();
    for (const [k, v] of next) checkouts.set(k, v);
    refreshStatus();
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
  context.subscriptions.push(
    timeline.onDidChange(refreshStatus),
    recorder.onDidChangeScope(() => void refreshCheckouts()),
    vscode.workspace.onDidChangeWorkspaceFolders(() => void refreshCheckouts()),
    // Worktrees made elsewhere (a sibling directory, or while stopped) send no event here.
    vscode.window.onDidChangeWindowState((w) => w.focused && void refreshCheckouts()),
  );
  refreshStatus();
  void refreshCheckouts();

  const setWatching = (on: boolean) => vscode.commands.executeCommand('setContext', 'agentTypewriter.watching', on);

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
    await setWatching(true);
    vscode.window.setStatusBarMessage(`Agent Typewriter: watching ${recorder.watchedCount} files (${recorder.describeFilter()})`, 4000);
  });

  register('agentTypewriter.stop', async () => {
    recorder.stop();
    await setWatching(false);
  });

  register('agentTypewriter.togglePause', () => {
    player.togglePause();
  });

  // The two states of the mirror's play/pause button; a stale click never flips playback back.
  register('agentTypewriter.pause', () => {
    if (!player.isPaused) player.togglePause();
  });

  register('agentTypewriter.resume', () => {
    if (player.isPaused) player.togglePause();
  });

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
    if (player.isPaused) player.togglePause();
  });

  register('agentTypewriter.replayFrom', async (arg?: ChangeItem | number) => {
    const seq = typeof arg === 'number' ? arg : arg?.event.seq;
    if (seq === undefined) return;
    timeline.seek(seq);
    await player.interrupt();
    if (player.isPaused) player.togglePause();
  });

  // Like replayFrom, but keeps the pause state; past the newest change it skips to latest.
  const seekTo = async (seq: number) => {
    const events = timeline.all();
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
    const playing = timeline.all().find((e) => timeline.stateOf(e.seq) === 'playing');
    await seekTo((playing?.seq ?? timeline.cursor) + 1);
  });

  register('agentTypewriter.showDiff', async (arg?: ChangeItem) => {
    if (!arg) return;
    const e = arg.event;
    await vscode.commands.executeCommand(
      'vscode.diff',
      SnapshotProvider.uriFor(e.seq, 'before', e.relPath),
      SnapshotProvider.uriFor(e.seq, 'after', e.relPath),
      `${e.relPath} (#${e.seq} ${e.kind})`,
      { preview: true },
    );
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
    const limit = readSettings().historyLimit;
    if (session.events.length > limit) {
      const raise = `Raise historyLimit to ${session.events.length}`;
      const pick = interactive
        ? await vscode.window.showWarningMessage(
            `${name} has ${session.events.length} changes but historyLimit is ${limit}.`,
            { modal: true },
            raise,
            `Load newest ${limit}`,
          )
        : undefined;
      if (interactive && !pick) return;
      if (pick === raise) {
        await updateSetting('historyLimit', session.events.length);
        timeline.setLimit(session.events.length);
      } else if (!interactive) {
        vscode.window.showWarningMessage(`Agent Typewriter: loaded the newest ${limit} of ${session.events.length} changes (historyLimit).`);
      }
    }
    // Loaded sessions start paused at their first change; the user resumes when ready.
    if (!player.isPaused) player.togglePause();
    // Changes recorded while the prompts were open are replaced too.
    recorder.drainHeld();
    timeline.restore(session.events, session.events[0].seq);
    await player.interrupt();
    log.appendLine(`Loaded ${timeline.all().length} change(s) from ${uri.fsPath}; playback paused.`);
    vscode.window.setStatusBarMessage(`Agent Typewriter: loaded ${timeline.all().length} change(s). Resume playback to start.`, 6000);
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
      if (c && (c.worktrees.length > 1 || pathArg !== undefined)) candidates.push([folder, c]);
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
        candidates.map(([folder, c]) => ({ label: folder.name, detail: `${c.worktrees.length} checkouts`, entry: [folder, c] as const })),
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
    const pick = await vscode.window.showQuickPick(
      [
        {
          label: c.own ? checkoutName(c.own) : folder.name,
          description: ["this folder's checkout", mark(c.own?.path ?? folder.uri.fsPath)].filter(Boolean).join(' · '),
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
    }
    if (['gitBaselines', 'baselineBudgetMB', 'maxFileSizeKB'].some(affects)) await recorder.refreshBaselines();
    if (affects('persistHistory')) applyPersistHistory();
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
        const pending = saved.events.filter((e) => e.seq >= saved.cursor).length;
        if (pending > 0 && !player.isPaused) player.togglePause();
        timeline.restore(saved.events, saved.cursor);
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
  finalSave = () => {
    recorder.drainHeld();
    if (store?.isRunning) store.flushSync();
  };
  context.subscriptions.push({ dispose: () => (finalSave = undefined) });

  void setWatching(false);
  await historyRestored;
  noteUnknownProfile();
  noteDeprecatedSpeed();
  if (readSettings().autoStart && vscode.workspace.workspaceFolders?.length) {
    void vscode.commands.executeCommand('agentTypewriter.start');
  }
  return { timeline, player, recorder, store, scrubber, refreshCheckouts, mirrorControls };
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
