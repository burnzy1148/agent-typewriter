// Runs in a VS Code launch on a saved multi-root workspace (see runTest.ts;
// folders.ts starts it, since package.json bundles a fixed list of entries),
// opened through a symlink except on Windows: [client/app, server/app, proj,
// repo]. Checks display paths that never share a mirror, the checkout choice
// of a folder holding a bare repository's worktree, and own saves in a chosen
// nested worktree (review group REC4).
import * as vscode from 'vscode';
import * as fs from 'node:fs';
import * as path from 'node:path';
import assert from 'node:assert/strict';
import type { AgentTypewriterApi } from '../src/extension';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function runRec4(): Promise<void> {
  const ext = vscode.extensions.getExtension<AgentTypewriterApi>('burnzy1148.agent-typewriter');
  assert.ok(ext, 'extension not found');
  const api = await ext.activate();
  const { timeline, recorder } = api;
  async function until(what: string, fn: () => boolean, timeoutMs = 30000) {
    const start = Date.now();
    while (!fn()) {
      if (Date.now() - start > timeoutMs) {
        console.log(`[it] timed out waiting for ${what}. Recorder activity:\n${recorder.describeActivity()}`);
        console.log(`[it] timeline: ${timeline.all().map((e) => `${e.kind} ${e.relPath}`).join(', ')}`);
        throw new Error(`timed out waiting for ${what}`);
      }
      await sleep(50);
    }
  }
  // On Windows another process can briefly hold a file open; retry instead of failing.
  const write = async (file: string, text: string) => {
    for (let attempt = 0; ; attempt++) {
      try {
        return fs.writeFileSync(file, text);
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        if ((code !== 'EBUSY' && code !== 'EPERM') || attempt >= 100) throw err;
        await sleep(50);
      }
    }
  };
  const folders = vscode.workspace.workspaceFolders!;
  assert.deepEqual(
    folders.map((f) => f.name),
    ['app', 'app', 'proj', 'repo'],
  );
  const [client, server, proj, repo] = folders;
  console.log(`[it] REC4 workspace opened at ${process.env.IT_REC4}; repo folder is ${repo.uri.fsPath}`);
  const file = (folder: vscode.WorkspaceFolder, rel: string) => vscode.Uri.joinPath(folder.uri, ...rel.split('/'));
  // Both spellings: VS Code may resolve the symlink the workspace was opened through.
  const hasBaseline = (folder: vscode.WorkspaceFolder, rel: string) =>
    [file(folder, rel), vscode.Uri.file(path.join(fs.realpathSync.native(folder.uri.fsPath), ...rel.split('/')))].some((u) => recorder.hasBaseline(u));
  const since = (from: number) => timeline.all().slice(from);
  const idle = () => timeline.pendingCount() === 0 && !timeline.all().some((e) => timeline.stateOf(e.seq) === 'playing');
  /** Waits for debounces and reads to finish, then hands held changes to the timeline. */
  const settled = async () => {
    await sleep(1500);
    for (let i = 0; i < 200 && !recorder.describeActivity().includes('debouncing: none; reading: 0;'); i++) await sleep(50);
    recorder.drainHeld();
  };
  const mirrorText = (rel: string) =>
    vscode.workspace.textDocuments.find((d) => d.uri.scheme === 'agent-typewriter' && d.uri.path === '/' + rel)?.getText();

  await vscode.commands.executeCommand('agentTypewriter.start');
  await until('app baselines', () => hasBaseline(client, 'src/index.ts') && hasBaseline(server, 'src/index.ts'));

  // --- at-l3q.11.6: two folders named app never share a display path or mirror.
  const atApps = timeline.all().length;
  await write(path.join(client.uri.fsPath, 'src', 'index.ts'), "export const side = 'client 2';\n");
  await until('client change', () => since(atApps).length >= 1);
  await write(path.join(server.uri.fsPath, 'src', 'index.ts'), "export const side = 'server 2';\n");
  await until('server change', () => since(atApps).length >= 2);
  await settled();
  assert.deepEqual(
    since(atApps).map((e) => [e.kind, e.relPath]),
    [
      ['modify', 'client-app/src/index.ts'],
      ['modify', 'server-app/src/index.ts'],
    ],
  );
  const latest = timeline.latestStates();
  assert.equal(latest.get('client-app/src/index.ts')?.after, "export const side = 'client 2';\n");
  assert.equal(latest.get('server-app/src/index.ts')?.after, "export const side = 'server 2';\n");
  await until('app playback', idle);
  await until('two app mirrors', () => mirrorText('client-app/src/index.ts') !== undefined && mirrorText('server-app/src/index.ts') !== undefined);
  assert.equal(mirrorText('client-app/src/index.ts'), "export const side = 'client 2';\n");
  assert.equal(mirrorText('server-app/src/index.ts'), "export const side = 'server 2';\n");
  console.log('[it] REC4: same-named folders ok');

  // --- at-l3q.11.8: outside Windows, a file named `src\index.ts` is not src/index.ts.
  if (process.platform !== 'win32') {
    const atOdd = timeline.all().length;
    await write(path.join(client.uri.fsPath, 'src\\index.ts'), 'export const odd = 1;\n');
    await until('backslash file recorded', () => since(atOdd).length >= 1);
    await settled();
    assert.deepEqual(
      since(atOdd).map((e) => [e.kind, e.relPath]),
      [['create', 'client-app/src\\index.ts']],
    );
    assert.equal(timeline.latestStates().get('client-app/src/index.ts')?.after, "export const side = 'client 2';\n");
    await until('backslash playback', idle);
    console.log('[it] REC4: backslash file names ok');
  }

  // --- at-l3q.11.2: a bare repository's container folder can choose its one worktree.
  const projKey = proj.uri.toString();
  const checkouts = await api.refreshCheckouts();
  const projEntry = checkouts.get(projKey);
  assert.deepEqual(projEntry && { ...projEntry }, { own: true, name: '(none chosen)', worktrees: 2 }, 'the container is not choosable');
  assert.match(recorder.describeFilter(), /no checkout chosen in proj/);
  const projFile = path.join(proj.uri.fsPath, 'main', 'src', 'a.ts');
  const atProj = timeline.all().length;
  await write(projFile, 'export const a = 2;\n');
  await settled();
  assert.deepEqual(since(atProj).map((e) => e.relPath), [], 'a worktree of the container was recorded with none chosen');
  await vscode.commands.executeCommand('agentTypewriter.chooseCheckout', proj.uri, path.join(proj.uri.fsPath, 'main'));
  await until('main chosen', () => recorder.checkoutOf(proj)?.name === 'main');
  await until('main baseline', () => hasBaseline(proj, 'main/src/a.ts'));
  await write(projFile, 'export const a = 3;\n');
  await until('main change', () => since(atProj).length >= 1);
  await settled();
  assert.deepEqual(
    since(atProj).map((e) => [e.kind, e.relPath, e.before]),
    [['modify', 'proj/main/src/a.ts', 'export const a = 2;\n']],
  );
  const chosen = (await api.refreshCheckouts()).get(projKey);
  assert.deepEqual(chosen && { ...chosen }, { own: false, name: 'main', worktrees: 2 });
  await until('proj playback', idle);
  console.log('[it] REC4: bare repository container ok');

  // --- at-l3q.11.4: an own save in a chosen nested worktree, opened through the folder's spelling.
  await vscode.commands.executeCommand('agentTypewriter.chooseCheckout', repo.uri, path.join(repo.uri.fsPath, '.worktrees', 'nested'));
  await until('nested chosen', () => recorder.checkoutOf(repo)?.own === false);
  const nestedRel = '.worktrees/nested/src/a.ts';
  await until('nested baseline in the folder spelling', () => recorder.hasBaseline(file(repo, nestedRel)));
  await settled();
  const atSave = timeline.all().length;
  const doc = await vscode.workspace.openTextDocument(file(repo, nestedRel));
  const editor = await vscode.window.showTextDocument(doc);
  await editor.edit((b) => b.insert(new vscode.Position(0, 0), '// saved by the user\n'));
  await doc.save();
  const saved = doc.getText();
  await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
  await settled();
  await sleep(1500);
  recorder.drainHeld();
  assert.deepEqual(since(atSave).map((e) => `${e.kind} ${e.relPath}`), [], "the user's own save in the nested worktree was recorded");
  await write(path.join(repo.uri.fsPath, ...nestedRel.split('/')), saved + 'export const agent = 1;\n');
  await until('agent write after the save', () => since(atSave).length >= 1);
  await settled();
  assert.deepEqual(
    since(atSave).map((e) => [e.kind, e.relPath, e.before]),
    [['modify', 'repo/nested/src/a.ts', saved]],
  );
  console.log('[it] REC4: own saves in a chosen nested worktree ok');

  await until('final playback', idle);
  await vscode.commands.executeCommand('agentTypewriter.stop');
}
