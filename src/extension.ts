import * as vscode from 'vscode';
import * as os from 'node:os';
import * as path from 'node:path';
import { readSettings, setRepoValues, updateSetting, workspaceOverrides, SECTION } from './config';
import { parseExtensionList, PathFilter } from './filter';
import { MirrorFileSystem, MIRROR_SCHEME, SnapshotProvider, SNAPSHOT_SCHEME } from './mirrorFs';
import { sessionFromBytes, sessionToBytes, TimelineStore } from './persistence';
import { Player } from './player';
import { Recorder, relPathOf } from './recorder';
import { scrubberState } from './scrubberState';
import { ScrubberView } from './scrubberView';
import { REPO_SETTINGS_FILE } from './repoSettings';
import { RepoSettingsFile } from './repoSettingsFile';
import { Timeline, toSession } from './timeline';
import { ChangeItem, TimelineView } from './timelineView';

/** Returned from activate so integration tests (or other extensions) can observe playback. */
export interface AgentTypewriterApi {
  timeline: Timeline;
  player: Player;
  recorder: Recorder;
  scrubber: ScrubberView;
  /** Undefined when no folder is open (no workspace storage). */
  store: TimelineStore | undefined;
}

/** Final save on deactivation, set while active. */
let finalSave: (() => void) | undefined;

export function activate(context: vscode.ExtensionContext): AgentTypewriterApi {
  const log = vscode.window.createOutputChannel('Agent Typewriter');
  const repoFile = new RepoSettingsFile(log);
  const timeline = new Timeline(readSettings().historyLimit);
  const mirror = new MirrorFileSystem();
  const recorder = new Recorder(timeline, readSettings, log);
  const player = new Player(timeline, mirror, readSettings, log);
  const view = new TimelineView(timeline);
  const tree = vscode.window.createTreeView('agentTypewriter.timeline', { treeDataProvider: view });
  const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 50);
  const scrubber = new ScrubberView(() =>
    scrubberState(timeline, { paused: player.isPaused, speed: player.speed, watching: recorder.isRunning }),
  );
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
    scrubber,
    vscode.window.registerWebviewViewProvider(ScrubberView.id, scrubber),
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
    scrubber.refresh();
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
    await repoFile.ready;
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

  /** Applies a change to the given settings, whether it came from VS Code settings or the repository file. */
  const applySettingsChange = async (affects: (key: string) => boolean) => {
    if (affects('historyLimit')) timeline.setLimit(readSettings().historyLimit);
    if (affects('include') || affects('exclude') || affects('extensions')) await recorder.refreshFilter();
    if (affects('gitBaselines') || affects('baselineBudgetMB')) await recorder.refreshBaselines();
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
      const overridden = workspaceOverrides(Object.keys(repoFile.values));
      if (overridden.length > 0) {
        log.appendLine(`Workspace settings override ${REPO_SETTINGS_FILE} for: ${overridden.join(', ')}.`);
      }
      await applySettingsChange((key) => changed.includes(key));
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

  void setWatching(false);
  if (readSettings().autoStart && vscode.workspace.workspaceFolders?.length) {
    void vscode.commands.executeCommand('agentTypewriter.start');
  }
  return { timeline, player, recorder, store, scrubber };
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
