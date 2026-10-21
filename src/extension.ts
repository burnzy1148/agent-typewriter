import * as vscode from 'vscode';
import { readSettings, updateSetting, SECTION } from './config';
import { parseExtensionList, PathFilter } from './filter';
import { MirrorFileSystem, MIRROR_SCHEME, SnapshotProvider, SNAPSHOT_SCHEME } from './mirrorFs';
import { TimelineStore } from './persistence';
import { Player } from './player';
import { Recorder, relPathOf } from './recorder';
import { Timeline } from './timeline';
import { ChangeItem, TimelineView } from './timelineView';

/** Returned from activate so integration tests (or other extensions) can observe playback. */
export interface AgentTypewriterApi {
  timeline: Timeline;
  player: Player;
  recorder: Recorder;
  /** Undefined when no folder is open (no workspace storage). */
  store: TimelineStore | undefined;
}

/** Final save on deactivation, set while active. */
let finalSave: (() => void) | undefined;

export function activate(context: vscode.ExtensionContext): AgentTypewriterApi {
  const log = vscode.window.createOutputChannel('Agent Typewriter');
  const timeline = new Timeline(readSettings().historyLimit);
  const mirror = new MirrorFileSystem();
  const recorder = new Recorder(timeline, readSettings, log);
  const player = new Player(timeline, mirror, readSettings, log);
  const view = new TimelineView(timeline);
  const tree = vscode.window.createTreeView('agentTypewriter.timeline', { treeDataProvider: view });
  const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 50);
  const store = context.storageUri
    ? new TimelineStore(context.storageUri.fsPath, timeline, (line) => log.appendLine(line))
    : undefined;

  context.subscriptions.push(
    log,
    recorder,
    player,
    view,
    tree,
    status,
    { dispose: () => store?.dispose() },
    vscode.workspace.registerFileSystemProvider(MIRROR_SCHEME, mirror, { isCaseSensitive: true }),
    vscode.workspace.registerTextDocumentContentProvider(SNAPSHOT_SCHEME, new SnapshotProvider((seq) => timeline.get(seq))),
  );

  // ------------------------------------------------------------ status

  let lastDropped = 0;
  const refreshStatus = () => {
    const pending = timeline.pendingCount();
    const watching = recorder.isRunning;
    const speed = player.speed === 1 ? '' : ` ${player.speed}x`;
    if (!watching && pending === 0) {
      status.text = '$(keyboard) Typewriter';
      status.tooltip = 'Agent Typewriter is not watching. Click to start.';
      status.command = 'agentTypewriter.start';
    } else if (player.isPaused) {
      status.text = `$(debug-pause) Typewriter paused${pending ? ` · ${pending} queued` : ''}`;
      status.tooltip = 'Click to resume playback.';
      status.command = 'agentTypewriter.togglePause';
    } else {
      status.text = `$(${watching ? 'record' : 'play'}) Typewriter${pending ? ` · ${pending} queued` : ''}${speed}`;
      status.tooltip = `${watching ? `Watching ${recorder.watchedCount} files (${recorder.describeFilter()})` : 'Not watching; draining the buffer'}. Click to pause.`;
      status.command = 'agentTypewriter.togglePause';
    }
    status.show();
    tree.description = watching ? recorder.describeFilter() : 'stopped';
    if (timeline.droppedUnplayed > lastDropped) {
      lastDropped = timeline.droppedUnplayed;
      tree.message = `${lastDropped} queued change(s) were dropped because the buffer is full (historyLimit).`;
    } else if (timeline.droppedUnplayed === 0) {
      lastDropped = 0;
      tree.message = undefined;
    }
  };
  context.subscriptions.push(timeline.onDidChange(refreshStatus));
  refreshStatus();

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

  register('agentTypewriter.finishCurrent', () => player.finishCurrent());

  register('agentTypewriter.catchUp', async () => {
    recorder.drainHeld();
    timeline.seekToEnd();
    await player.interrupt();
    await player.snapToLatest();
  });

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
    timeline.clear();
    await player.interrupt();
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

  const globsFor = async (uris: vscode.Uri[]) => {
    const globs: string[] = [];
    for (const uri of uris) {
      const rel = relPathOf(uri);
      const stat = await vscode.workspace.fs.stat(uri);
      globs.push(stat.type & vscode.FileType.Directory ? `${rel}/**` : rel);
    }
    return globs;
  };

  const warnIfStillFiltered = (uris: vscode.Uri[]) => {
    const s = readSettings();
    const f = new PathFilter(s);
    const blocked = uris.filter((u) => !f.matches(relPathOf(u)) && !u.path.endsWith('/'));
    if (blocked.length > 0 && s.extensions.length > 0) {
      void vscode.window
        .showWarningMessage(
          `Agent Typewriter: ${relPathOf(blocked[0])} is still filtered out by the extension list (${s.extensions.join(', ')}).`,
          'Clear Extension Filter',
        )
        .then((pick) => pick && updateSetting('extensions', []));
    }
  };

  register('agentTypewriter.watchOnlyThis', async (clicked?: vscode.Uri, selected?: vscode.Uri[]) => {
    const uris = selected?.length ? selected : clicked ? [clicked] : [];
    if (uris.length === 0) return;
    await updateSetting('include', await globsFor(uris));
    warnIfStillFiltered(uris);
  });

  register('agentTypewriter.addToWatch', async (clicked?: vscode.Uri, selected?: vscode.Uri[]) => {
    const uris = selected?.length ? selected : clicked ? [clicked] : [];
    if (uris.length === 0) return;
    const existing = readSettings().include.filter((g) => g !== '**/*' && g !== '**');
    const merged = [...new Set([...existing, ...(await globsFor(uris))])];
    await updateSetting('include', merged);
    warnIfStillFiltered(uris);
  });

  register('agentTypewriter.resetFilters', async () => {
    await updateSetting('include', undefined);
    await updateSetting('exclude', undefined);
    await updateSetting('extensions', undefined);
  });

  register('agentTypewriter.setSpeed', async () => {
    const options = [0.5, 1, 1.5, 2, 3, 5].map((m) => ({
      label: `${m}x`,
      description: m === player.speed ? 'current' : undefined,
      multiplier: m,
    }));
    const pick = await vscode.window.showQuickPick(
      [...options, { label: 'Base speed...', description: `${readSettings().charsPerSecond} chars/sec setting`, multiplier: 0 }],
      { title: 'Agent Typewriter: playback speed (catch-up acceleration still applies on top)' },
    );
    if (!pick) return;
    if (pick.multiplier > 0) {
      player.setSpeed(pick.multiplier);
      return;
    }
    const input = await vscode.window.showInputBox({
      title: 'Base typing speed (characters per second)',
      value: String(readSettings().charsPerSecond),
      validateInput: (v) => (Number(v) > 0 ? undefined : 'Enter a positive number'),
    });
    if (input) await updateSetting('charsPerSecond', Number(input));
  });

  // ------------------------------------------------------------ settings

  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration(async (e) => {
      if (!e.affectsConfiguration(SECTION)) return;
      if (e.affectsConfiguration(`${SECTION}.historyLimit`)) timeline.setLimit(readSettings().historyLimit);
      if (
        e.affectsConfiguration(`${SECTION}.include`) ||
        e.affectsConfiguration(`${SECTION}.exclude`) ||
        e.affectsConfiguration(`${SECTION}.extensions`)
      ) {
        await recorder.refreshFilter();
      }
      if (e.affectsConfiguration(`${SECTION}.gitBaselines`) || e.affectsConfiguration(`${SECTION}.baselineBudgetMB`)) {
        await recorder.refreshBaselines();
      }
      refreshStatus();
    }),
  );

  // ------------------------------------------------------------ history

  const applyPersistHistory = () => {
    if (!store) return;
    if (readSettings().persistHistory) store.start();
    else if (store.isRunning) {
      store.stop();
      store.deleteSaved();
    }
  };
  // Restore before anything can record. The player is waiting on the empty
  // timeline, so pausing it first means restored queued changes are not typed
  // until the user resumes.
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
  applyPersistHistory();
  finalSave = () => {
    recorder.drainHeld();
    if (store?.isRunning) store.flushSync();
  };
  context.subscriptions.push({ dispose: () => (finalSave = undefined) });
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration(`${SECTION}.persistHistory`)) applyPersistHistory();
    }),
  );

  void setWatching(false);
  if (readSettings().autoStart && vscode.workspace.workspaceFolders?.length) {
    void vscode.commands.executeCommand('agentTypewriter.start');
  }
  return { timeline, player, recorder, store };
}

export function deactivate(): void {
  // Save before the disposables run, with every held change in the timeline.
  // Disposables registered on the context clean up the rest.
  finalSave?.();
}
