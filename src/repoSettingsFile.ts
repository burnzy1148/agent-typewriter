import * as vscode from 'vscode';
import { REPO_SETTINGS_FILE, changedKeys, parseRepoSettings, type RepoValues } from './repoSettings';

/**
 * Reads and watches the repository settings file in the first workspace
 * folder. Only reads: the extension never writes this file.
 */
export class RepoSettingsFile implements vscode.Disposable {
  private current: RepoValues = {};
  /** True while the file on disk is unusable; its previous values stay in effect. */
  private broken = false;
  private watcher: vscode.FileSystemWatcher | undefined;
  private loading: Promise<void> = Promise.resolve();
  private readonly emitter = new vscode.EventEmitter<string[]>();
  private readonly folderSub: vscode.Disposable;
  private readonly decoder = new TextDecoder('utf-8');
  /** Fires with the keys whose value changed. */
  readonly onDidChange = this.emitter.event;
  /** Settles once the file has been read for the first time. */
  readonly ready: Promise<void>;

  constructor(private readonly log: vscode.OutputChannel) {
    this.folderSub = vscode.workspace.onDidChangeWorkspaceFolders(() => {
      this.watch();
      void this.reload();
    });
    this.watch();
    this.ready = this.reload();
  }

  get values(): RepoValues {
    return this.current;
  }

  /** Where the file lives, or undefined without a workspace folder. */
  get uri(): vscode.Uri | undefined {
    const folder = vscode.workspace.workspaceFolders?.[0];
    return folder && vscode.Uri.joinPath(folder.uri, REPO_SETTINGS_FILE);
  }

  /** Re-reads the file. Reads run one at a time so events apply in order. */
  reload(): Promise<void> {
    this.loading = this.loading.then(() => this.load()).catch((err) => {
      this.log.appendLine(`Could not read ${REPO_SETTINGS_FILE}: ${err instanceof Error ? err.message : String(err)}`);
    });
    return this.loading;
  }

  dispose(): void {
    this.watcher?.dispose();
    this.folderSub.dispose();
    this.emitter.dispose();
  }

  private watch(): void {
    this.watcher?.dispose();
    const folder = vscode.workspace.workspaceFolders?.[0];
    this.watcher = folder && vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(folder, REPO_SETTINGS_FILE));
    const reload = () => void this.reload();
    this.watcher?.onDidCreate(reload);
    this.watcher?.onDidChange(reload);
    this.watcher?.onDidDelete(reload);
  }

  private async load(): Promise<void> {
    const uri = this.uri;
    const bytes = uri && (await readIfExists(uri));
    let next: RepoValues = {};
    if (bytes) {
      const r = parseRepoSettings(this.decoder.decode(bytes));
      if (!r.ok) {
        if (!this.broken) {
          this.broken = true;
          this.log.appendLine(`${REPO_SETTINGS_FILE} is not usable (${r.error}); keeping its previous values until it is fixed.`);
          void vscode.window.showWarningMessage(
            `Agent Typewriter: ${REPO_SETTINGS_FILE} is not valid JSON. Its previous values stay in effect until it is fixed.`,
          );
        }
        return;
      }
      for (const p of r.problems) this.log.appendLine(`${REPO_SETTINGS_FILE}: ${p}`);
      next = r.values;
    }
    this.broken = false;
    const changed = changedKeys(this.current, next);
    if (changed.length === 0) return;
    this.current = next;
    this.log.appendLine(
      bytes
        ? `Loaded ${REPO_SETTINGS_FILE}: ${Object.keys(next).join(', ') || 'no settings'}.`
        : `${REPO_SETTINGS_FILE} removed; its settings no longer apply.`,
    );
    this.emitter.fire(changed);
  }
}

async function readIfExists(uri: vscode.Uri): Promise<Uint8Array | undefined> {
  try {
    return await vscode.workspace.fs.readFile(uri);
  } catch (err) {
    if (err instanceof vscode.FileSystemError && err.code === 'FileNotFound') return undefined;
    throw err;
  }
}
