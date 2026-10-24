// Second VS Code launch on the workspace suite.ts left behind (see runTest.ts).
// Checks that the timeline came back from workspace storage like a reload would.
import * as vscode from 'vscode';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import assert from 'node:assert/strict';
import type { AgentTypewriterApi } from '../src/extension';
import { highlightedFiles, persisted } from './suite';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function until(what: string, fn: () => boolean, timeoutMs = 30000) {
  const start = Date.now();
  while (!fn()) {
    if (Date.now() - start > timeoutMs) throw new Error(`timed out waiting for ${what}`);
    await sleep(50);
  }
}

export async function run(): Promise<void> {
  const ext = vscode.extensions.getExtension<AgentTypewriterApi>('burnzy1148.agent-typewriter');
  assert.ok(ext, 'extension not found');
  const api = await ext.activate();
  const { timeline, player } = api;
  const root = vscode.workspace.workspaceFolders![0].uri.fsPath;
  const disk = (rel: string) => fs.readFileSync(path.join(root, rel), 'utf8');
  const mirrorText = (rel: string) =>
    vscode.workspace.textDocuments.find((d) => d.uri.scheme === 'agent-typewriter' && d.uri.path === '/' + rel)?.getText();
  const idle = () => timeline.pendingCount() === 0 && !timeline.all().some((e) => timeline.stateOf(e.seq) === 'playing');
  const expected = JSON.parse(fs.readFileSync(process.env.IT_EXPECT!, 'utf8'));

  // --- 0. Mirror tabs left open before the reload reopen with the text they
  // showed, in their line ending, before anything plays. VS Code does not
  // restore editors in these test launches, so a tab it did not restore is
  // opened here; opening one it did restore loads its document.
  {
    const mirrorTabs = expected.mirrorTabs as Record<string, { text: string; eol: string }>;
    const { refilled, closed } = await api.mirrorRestore;
    assert.ok(refilled >= Object.keys(mirrorTabs).length, `activation refilled only ${refilled} mirror file(s)`);
    const tabOf = (uri: vscode.Uri) =>
      vscode.window.tabGroups.all.flatMap((g) => g.tabs).find((t) => t.input instanceof vscode.TabInputText && t.input.uri.toString() === uri.toString());
    let restoredByVsCode = 0;
    for (const [rel, want] of Object.entries(mirrorTabs)) {
      const uri = vscode.Uri.from({ scheme: 'agent-typewriter', path: '/' + rel });
      if (tabOf(uri)) restoredByVsCode++;
      await vscode.commands.executeCommand('vscode.open', uri, { preview: false });
      const text = want.eol === '\r\n' ? want.text.replace(/\n/g, '\r\n') : want.text;
      await until(`restored mirror tab for ${rel}`, () => mirrorText(rel) === text, 10000);
      const doc = vscode.workspace.textDocuments.find((d) => d.uri.toString() === uri.toString())!;
      assert.equal(doc.eol, want.eol === '\r\n' ? vscode.EndOfLine.CRLF : vscode.EndOfLine.LF, `restored mirror for ${rel} lost its line ending`);
      assert.ok(tabOf(uri), `mirror tab for ${rel} is not open`);
    }
    console.log(`[it] mirror tabs reopen after reload ok (${refilled} refilled, ${closed} orphan tab(s) closed, ${restoredByVsCode} tab(s) restored by VS Code)`);

    // A clear made before the reload still applies: the same files are highlighted, and a reopened tab shows its marks.
    assert.deepEqual(highlightedFiles(timeline), expected.highlighted, 'highlighted files differ after the reload');
    const playedUri = vscode.Uri.from({ scheme: 'agent-typewriter', path: '/src/tabPlayed.ts' });
    await vscode.commands.executeCommand('vscode.open', playedUri, { preview: false });
    await until(
      'restored highlights on tabPlayed.ts',
      () => JSON.stringify(api.highlights.drawn.get(playedUri.toString())) === JSON.stringify({ lines: [0], chars: [], removals: [] }),
      10000,
    );
    console.log('[it] highlights after reload ok');
  }

  // --- 1. Same changes, same recorded text, same queue; playback paused.
  assert.deepEqual(timeline.all().map(persisted), expected.events, 'restored changes differ from the recorded ones');
  assert.equal(timeline.pendingCount(), expected.pending, 'queued count not restored');
  assert.ok(player.isPaused, 'playback is not paused with queued changes');
  await sleep(500);
  assert.equal(timeline.pendingCount(), expected.pending, 'restored changes played while paused');
  assert.equal(mirrorText('src/queued1.ts'), undefined, 'a mirror was typed into while paused');
  assert.ok(api.store, 'no timeline store');
  assert.ok(!path.resolve(api.store.path).startsWith(path.resolve(root)), 'timeline saved inside the workspace');
  console.log(`[it] restore ok: ${timeline.all().length} changes, ${timeline.pendingCount()} queued, paused`);

  // --- 2. Resuming plays the queued changes in order.
  const order: string[] = [];
  timeline.onDidChange(() => {
    const p = timeline.all().find((e) => timeline.stateOf(e.seq) === 'playing');
    if (p && order[order.length - 1] !== p.relPath) order.push(p.relPath);
  });
  await vscode.commands.executeCommand('agentTypewriter.togglePause');
  await until('restored queue to play', idle);
  assert.deepEqual(order, ['src/tabQueued.ts', 'src/queued1.ts', 'src/queued2.ts'], 'restored queue played out of order');
  for (const rel of ['src/tabQueued.ts', 'src/queued1.ts', 'src/queued2.ts']) assert.equal(mirrorText(rel), disk(rel), `mirror for ${rel} does not match disk`);
  console.log('[it] resume after restore ok');

  // --- 2b. A mirror or compare tab with no mirror file behind it is closed; real-file tabs are not.
  {
    const orphan = vscode.Uri.from({ scheme: 'agent-typewriter', path: '/orphan/none.ts' });
    const real = vscode.Uri.file(path.join(root, 'src', 'queued1.ts'));
    await Promise.race([Promise.resolve(vscode.commands.executeCommand('vscode.open', orphan, { preview: false })).catch(() => undefined), sleep(3000)]);
    await vscode.commands.executeCommand('vscode.open', real, { preview: false });
    const open = (uri: vscode.Uri) =>
      vscode.window.tabGroups.all.flatMap((g) => g.tabs).some((t) => t.input instanceof vscode.TabInputText && t.input.uri.toString() === uri.toString());
    await until('orphan mirror tab to open', () => open(orphan), 5000);
    // A compare tab with an orphan mirror on one side is closed too.
    const orphanSide = vscode.Uri.from({ scheme: 'agent-typewriter', path: '/orphan/diff.ts' });
    await Promise.race([Promise.resolve(vscode.commands.executeCommand('vscode.diff', orphanSide, real, 'orphan diff', { preview: false })).catch(() => undefined), sleep(3000)]);
    const diffOpen = () =>
      vscode.window.tabGroups.all.flatMap((g) => g.tabs).some((t) => t.input instanceof vscode.TabInputTextDiff && t.input.original.toString() === orphanSide.toString());
    await until('orphan diff tab to open', diffOpen, 5000);
    assert.ok((await api.closeOrphanMirrorTabs()) >= 2, 'the orphan mirror tabs were not closed');
    assert.ok(!open(orphan), 'the orphan mirror tab is still open');
    assert.ok(!diffOpen(), 'the orphan diff tab is still open');
    assert.ok(open(real), 'a real-file tab was closed');
    for (const rel of Object.keys(expected.mirrorTabs)) {
      assert.ok(open(vscode.Uri.from({ scheme: 'agent-typewriter', path: '/' + rel })), `mirror tab for ${rel} was closed though it has history`);
    }
    console.log('[it] orphan mirror tabs close ok');
  }

  // --- 3. Save the session to a file outside the workspace, clear, load it, replay it.
  const gitStatus = () => execFileSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8' });
  const statusBefore = gitStatus();
  const recorded = timeline.all().map(persisted);
  const file = path.join(path.dirname(process.env.IT_EXPECT!), 'saved-session.json');
  await vscode.commands.executeCommand('agentTypewriter.saveSession', vscode.Uri.file(file));
  const onDisk = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(onDisk.format, 'agent-typewriter-session');
  assert.deepEqual(onDisk.events.map(persisted), recorded, 'saved file differs from the buffer');
  await sleep(800);
  assert.equal(gitStatus(), statusBefore, 'saving a session changed the workspace');

  await vscode.commands.executeCommand('agentTypewriter.clear');
  assert.equal(timeline.all().length, 0);
  await vscode.commands.executeCommand('agentTypewriter.loadSession', vscode.Uri.file(file));
  assert.deepEqual(timeline.all().map(persisted), recorded, 'loaded changes differ from the saved ones');
  // suite.ts recorded from more than one checkout, so the session holds more than one lane.
  const pendingAll = () => timeline.lanesInBuffer().reduce((n, lane) => n + timeline.pendingCount(lane), 0);
  assert.equal(pendingAll(), recorded.length, 'loaded changes are not all pending');
  assert.ok(player.isPaused, 'playback is not paused after loading');

  // A file that is not a session is refused and leaves the buffer alone.
  const bogus = path.join(path.dirname(file), 'not-a-session.json');
  fs.writeFileSync(bogus, '{"name":"package"}');
  await vscode.commands.executeCommand('agentTypewriter.loadSession', vscode.Uri.file(bogus));
  assert.equal(pendingAll(), recorded.length, 'a bad file changed the buffer');

  await vscode.commands.executeCommand('agentTypewriter.togglePause');
  // Replays every change suite.ts recorded, lane by lane, so allow time per change; Windows runners are the slowest.
  for (const lane of timeline.lanesInBuffer()) {
    await vscode.commands.executeCommand('agentTypewriter.followLane', lane);
    await until(`loaded lane ${lane || '(default)'} to play`, idle, Math.max(60000, timeline.pendingCount(lane) * 1500));
  }
  assert.equal(pendingAll(), 0, 'a lane was left unplayed');
  const last = new Map(recorded.map((e) => [e.relPath, e]));
  for (const [rel, e] of last) {
    assert.equal(mirrorText(rel)?.replace(/\r\n/g, '\n'), e.after, `mirror for ${rel} does not end at its last recorded text`);
  }
  console.log(`[it] save and load session ok: ${recorded.length} changes replayed from ${path.basename(file)}`);

  // --- 4. The checkout chosen before the reload is still the one recorded.
  const folder = vscode.workspace.workspaceFolders![0];
  await vscode.commands.executeCommand('agentTypewriter.start');
  assert.equal(api.recorder.checkoutOf(folder)?.own, false, 'the chosen checkout was not remembered');
  assert.equal(api.recorder.checkoutOf(folder)?.name, 'nested');
  const nestedFile = path.join(root, '.worktrees', 'nested', 'src', 'afterReload.ts');
  const at = timeline.all().length;
  await sleep(500);
  fs.writeFileSync(nestedFile, 'export const afterReload = 1;\n');
  await until('nested change after reload', () => timeline.all().slice(at).some((e) => e.relPath === 'nested/src/afterReload.ts'), 20000);
  await until('nested playback after reload', idle);
  await vscode.commands.executeCommand('agentTypewriter.stop');
  console.log('[it] chosen checkout survives reload ok');

  // --- PLAY. After a reload the mirror filesystem starts empty. Skip to Latest
  // fills every file's mirror, not only the newest one, with its line ending.
  {
    assert.ok(
      (ext.packageJSON.activationEvents as string[]).includes('onFileSystem:agent-typewriter'),
      'restored mirror tabs do not activate the extension',
    );
    const at = (rel: string, seq: number, kind: string, before: string, after: string, eol: string) => ({
      seq,
      uri: vscode.Uri.file(path.join(root, rel)).toString(),
      relPath: rel,
      time: Date.now(),
      kind,
      before,
      after,
      eol,
      linesAdded: 1,
      linesRemoved: 0,
    });
    const r1 = 'export const reload1 = 1;\n';
    const r1b = 'export const reload1 = 11;\n';
    const r2 = 'export const reload2 = 2;\n';
    const sessionFile = path.join(path.dirname(process.env.IT_EXPECT!), 'never-played.json');
    fs.writeFileSync(
      sessionFile,
      JSON.stringify({
        format: 'agent-typewriter-session',
        version: 1,
        savedAt: Date.now(),
        cursor: 4,
        events: [
          at('play/reload1.ts', 1, 'create', '', r1, '\r\n'),
          at('play/reload2.ts', 2, 'create', '', r2, '\n'),
          at('play/reload1.ts', 3, 'modify', r1, r1b, '\r\n'),
        ],
      }),
    );
    await vscode.commands.executeCommand('agentTypewriter.loadSession', vscode.Uri.file(sessionFile));
    // A tab left from before a reload: its mirror file does not exist yet, so it shows an error.
    const restored = vscode.Uri.from({ scheme: 'agent-typewriter', path: '/play/reload2.ts' });
    await Promise.race([Promise.resolve(vscode.commands.executeCommand('vscode.open', restored, { preview: false })).catch(() => undefined), sleep(3000)]);
    await vscode.commands.executeCommand('agentTypewriter.catchUp');
    const read = async (rel: string) =>
      new TextDecoder().decode(await vscode.workspace.fs.readFile(vscode.Uri.from({ scheme: 'agent-typewriter', path: '/' + rel })));
    assert.equal(await read('play/reload2.ts'), r2, 'Skip to Latest did not fill a mirror that was never played');
    assert.equal(await read('play/reload1.ts'), r1b.replace(/\n/g, '\r\n'), 'Skip to Latest lost the newest mirror or its CRLF');
    assert.equal(timeline.pendingCount(), 0);
    await until('the restored tab to load its mirror', () => vscode.workspace.textDocuments.some((d) => d.uri.toString() === restored.toString() && d.getText() === r2), 10000);
    if (player.isPaused) await vscode.commands.executeCommand('agentTypewriter.togglePause');
    console.log('[it] Skip to Latest fills unplayed mirrors ok');
  }

  // suite.ts set user-level historyLimit 10 and persistHistory false below the
  // repository file's 1000 and true. Section 1 restored all of the expected
  // changes, more than the user limit, and the saved timeline still holds what
  // the buffer does.
  const actStore = api.store!;
  assert.ok(expected.events.length > 10, `only ${expected.events.length} changes were left for the reload; the user historyLimit was not exercised`);
  assert.ok(actStore.isRunning, 'the timeline is not saved though the repository file turns persistHistory on');
  await actStore.flush();
  assert.equal(actStore.load()?.events.length, timeline.all().length, 'the saved timeline lost changes');
  console.log(`[it] ACT: repository file history settings survive the reload (${expected.events.length} changes restored)`);
}
