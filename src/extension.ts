import * as vscode from 'vscode';
import { readSettings, setRepoValues, updateSetting, workspaceOverrides, SECTION } from './config';
import { parseExtensionList, PathFilter } from './filter';
import { MirrorFileSystem, MIRROR_SCHEME, SnapshotProvider, SNAPSHOT_SCHEME } from './mirrorFs';
import { Player } from './player';
import { Recorder, relPathOf } from './recorder';
import { REPO_SETTINGS_FILE } from './repoSettings';
import { RepoSettingsFile } from './repoSettingsFile';
import { Timeline } from './timeline';
import { ChangeItem, TimelineView } from './timelineView';

/** Returned from activate so integration tests (or other extensions) can observe playback. */
export interface AgentTypewriterApi {
  timeline: Timeline;
  player: Player;
  recorder: Recorder;
}

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

  context.subscriptions.push(
    log,
    repoFile,
    recorder,
    player,
    view,
    tree,
    status,
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

  /** Applies a change to the given settings, whether it came from VS Code settings or the repository file. */
  const applySettingsChange = async (affects: (key: string) => boolean) => {
    if (affects('historyLimit')) timeline.setLimit(readSettings().historyLimit);
    if (affects('include') || affects('exclude') || affects('extensions')) await recorder.refreshFilter();
    if (affects('gitBaselines') || affects('baselineBudgetMB')) await recorder.refreshBaselines();
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

  void setWatching(false);
  if (readSettings().autoStart && vscode.workspace.workspaceFolders?.length) {
    void vscode.commands.executeCommand('agentTypewriter.start');
  }
  return { timeline, player, recorder };
}

export function deactivate(): void {
  // Disposables registered on the context clean everything up.
}
