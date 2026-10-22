// Runs inside a real VS Code instance (see runTest.ts). Simulates an agent
// writing files from outside the editor and checks what the replay does.
import * as vscode from 'vscode';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import assert from 'node:assert/strict';
import type { AgentTypewriterApi } from '../src/extension';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** What the recorder and timeline were doing, printed when a wait times out. Set once the extension is active. */
let describeState = () => '';

async function until(what: string, fn: () => boolean, timeoutMs = 30000) {
  const start = Date.now();
  while (!fn()) {
    if (Date.now() - start > timeoutMs) {
      console.log(`[it] timed out waiting for ${what}. State:\n${describeState()}`);
      throw new Error(`timed out waiting for ${what}`);
    }
    await sleep(50);
  }
}

export async function run(): Promise<void> {
  const ext = vscode.extensions.getExtension<AgentTypewriterApi>('burnzy1148.agent-typewriter');
  assert.ok(ext, 'extension not found');
  const api = await ext.activate();
  const { timeline } = api;
  const root = vscode.workspace.workspaceFolders![0].uri.fsPath;
  const write = (rel: string, text: string) => fs.writeFileSync(path.join(root, rel), text);
  const disk = (rel: string) => fs.readFileSync(path.join(root, rel), 'utf8');
  const mirrorText = (rel: string) =>
    vscode.workspace.textDocuments.find((d) => d.uri.scheme === 'agent-typewriter' && d.uri.path === '/' + rel)?.getText();
  const idle = () => timeline.pendingCount() === 0 && !timeline.all().some((e) => timeline.stateOf(e.seq) === 'playing');
  describeState = () =>
    [
      'recorder activity:',
      api.recorder.describeActivity(),
      `timeline (${timeline.all().length} events):`,
      ...timeline.all().slice(-20).map((e) => `  #${e.seq} ${e.kind} ${e.relPath} ${timeline.stateOf(e.seq)}`),
    ].join('\n');

  // Track which file playback is in, and how many separate edits hit the mirrors.
  const order: string[] = [];
  let lastSeq = -1;
  timeline.onDidChange(() => {
    const p = timeline.all().find((e) => timeline.stateOf(e.seq) === 'playing');
    if (p && p.seq !== lastSeq) {
      lastSeq = p.seq;
      order.push(p.relPath);
    }
  });
  let mirrorEdits = 0;
  vscode.workspace.onDidChangeTextDocument((e) => {
    if (e.document.uri.scheme === 'agent-typewriter' && e.contentChanges.length > 0) mirrorEdits++;
  });

  await vscode.commands.executeCommand('agentTypewriter.start');
  await sleep(500);

  // --- 1. Agent touches a.ts, b.ts, existing.ts, then a.ts again; plus a filtered .txt
  write('src/a.ts', 'export function add(a: number, b: number) {\n  return a + b;\n}\n');
  await sleep(350);
  write('src/b.ts', 'import { add } from "./a";\n\nconsole.log(add(1, 2));\n');
  await sleep(350);
  write('src/existing.ts', disk('src/existing.ts').replace('const total = 1;', 'const subtotal = 1;\nconst tax = 0.1;'));
  await sleep(350);
  write('notes.txt', 'this extension is filtered out\n');
  await sleep(350);
  write('src/a.ts', 'export function add(a: number, b: number): number {\n  return a + b;\n}\n\nexport const sub = (a: number, b: number) => a - b;\n');

  await until('4 events recorded', () => timeline.all().length >= 4);
  await sleep(400);
  await until('playback to drain', idle);

  assert.equal(timeline.all().length, 4, `expected 4 events (txt filtered), got ${timeline.all().map((e) => e.relPath).join(', ')}`);
  assert.deepEqual(order, ['src/a.ts', 'src/b.ts', 'src/existing.ts', 'src/a.ts'], 'files replayed out of order');
  for (const rel of ['src/a.ts', 'src/b.ts', 'src/existing.ts']) {
    assert.equal(mirrorText(rel), disk(rel), `mirror for ${rel} does not match disk`);
  }
  assert.ok(mirrorEdits > 20, `expected incremental typing, saw only ${mirrorEdits} edits`);
  const kinds = timeline.all().map((e) => e.kind).join(',');
  assert.equal(kinds, 'create,create,modify,modify');
  console.log(`[it] live recording ok: order=${order.join(' -> ')} edits=${mirrorEdits}`);

  // --- 2. Replay the whole buffer: same order again, same end state.
  order.length = 0;
  lastSeq = -1;
  await vscode.commands.executeCommand('agentTypewriter.replayAll');
  await sleep(200);
  await until('replay to drain', idle);
  assert.deepEqual(order, ['src/a.ts', 'src/b.ts', 'src/existing.ts', 'src/a.ts'], 'replay order wrong');
  assert.equal(mirrorText('src/a.ts'), disk('src/a.ts'));
  console.log('[it] replayAll ok');

  // --- 3. Skip to latest while a long change is mid-typing.
  await vscode.workspace.getConfiguration('agentTypewriter').update('charsPerSecond', 20, vscode.ConfigurationTarget.Workspace);
  write('src/b.ts', disk('src/b.ts') + '\n' + '// slow line that would take ages to type at 20 cps\n'.repeat(5));
  await until('slow change to start playing', () => timeline.all().some((e) => timeline.stateOf(e.seq) === 'playing'));
  await sleep(300);
  await vscode.commands.executeCommand('agentTypewriter.catchUp');
  assert.ok(idle(), 'still playing after catchUp');
  assert.equal(mirrorText('src/b.ts'), disk('src/b.ts'), 'catchUp did not snap mirror to latest');
  console.log('[it] catchUp ok');

  // --- 4. Deletion is recorded and replayed.
  await vscode.workspace.getConfiguration('agentTypewriter').update('charsPerSecond', 4000, vscode.ConfigurationTarget.Workspace);
  fs.unlinkSync(path.join(root, 'src/b.ts'));
  await until('delete event', () => timeline.all().some((e) => e.kind === 'delete'));
  await sleep(300);
  await until('delete playback', idle);
  assert.equal(mirrorText('src/b.ts'), '');
  console.log('[it] delete ok');

  // --- 5. Own saves from a VS Code editor are ignored.
  const before = timeline.all().length;
  const doc = await vscode.workspace.openTextDocument(path.join(root, 'src/existing.ts'));
  const ed = await vscode.window.showTextDocument(doc);
  await ed.edit((b) => b.insert(new vscode.Position(0, 0), '// typed by me\n'));
  await doc.save();
  await sleep(800);
  assert.equal(
    timeline.all().length,
    before,
    `own save was recorded: ${timeline.all().slice(before).map((e) => `${e.kind} ${e.relPath}`).join(', ')}`,
  );
  console.log('[it] ignoreOwnSaves ok');

  // --- 6. Changing the filter live picks up a new extension.
  // notes.txt already exists, so wait for its baseline: a write before it lands becomes the baseline.
  await vscode.workspace.getConfiguration('agentTypewriter').update('extensions', ['ts', 'txt'], vscode.ConfigurationTarget.Workspace);
  const notes = vscode.Uri.file(path.join(root, 'notes.txt'));
  await until('notes.txt baseline', () => api.recorder.hasBaseline(notes), 20000);
  write('notes.txt', 'now it is watched\n');
  await until('txt event after filter change', () => timeline.all().some((e) => e.relPath === 'notes.txt'), 20000);
  await until('txt playback', idle);
  assert.equal(mirrorText('notes.txt'), 'now it is watched\n');
  console.log('[it] live filter change ok');

  // --- 7. Line endings: CRLF files replay as CRLF, LF files as LF whatever files.eol says.
  const mirrorDoc = (rel: string) =>
    vscode.workspace.textDocuments.find((d) => d.uri.scheme === 'agent-typewriter' && d.uri.path === '/' + rel);
  const crlf = (lines: string[]) => lines.map((l) => l + '\r\n').join('');
  const lines = Array.from({ length: 50 }, (_, i) => `export const v${i} = ${i};`);
  write('src/crlf.ts', crlf(lines));
  await until('crlf create event', () => timeline.all().some((e) => e.relPath === 'src/crlf.ts'), 5000);
  await until('crlf create playback', idle);
  const edited = lines.slice();
  edited[25] = 'export const v25 = 25 * 2; // changed in the middle';
  write('src/crlf.ts', crlf(edited));
  await until('crlf modify event', () => timeline.all().filter((e) => e.relPath === 'src/crlf.ts').length === 2, 5000);
  await until('crlf modify playback', idle);
  assert.equal(mirrorDoc('src/crlf.ts')?.eol, vscode.EndOfLine.CRLF, 'CRLF file replayed with LF line endings');
  assert.equal(mirrorText('src/crlf.ts'), disk('src/crlf.ts'), 'CRLF mirror does not match disk');
  assert.equal(mirrorDoc('src/crlf.ts')?.lineAt(25).text, edited[25], 'edit landed on the wrong line');

  // A line-ending-only rewrite is not recorded; the next change uses the new ending.
  const crlfEvents = timeline.all().length;
  write('src/crlf.ts', edited.map((l) => l + '\n').join(''));
  await sleep(600);
  assert.equal(timeline.all().length, crlfEvents, 'line-ending-only rewrite was recorded');
  write('src/crlf.ts', edited.map((l) => l + '\n').join('') + 'export const last = true;\n');
  await until('lf modify event', () => timeline.all().length === crlfEvents + 1, 5000);
  await until('lf modify playback', idle);
  assert.equal(mirrorDoc('src/crlf.ts')?.eol, vscode.EndOfLine.LF, 'mirror kept CRLF after the file became LF');
  assert.equal(mirrorText('src/crlf.ts'), disk('src/crlf.ts'));

  // A new LF file stays LF even when VS Code's default is CRLF.
  await vscode.workspace.getConfiguration('files').update('eol', '\r\n', vscode.ConfigurationTarget.Workspace);
  write('src/lf.ts', 'export const a = 1;\nexport const b = 2;\n');
  await until('lf create event', () => timeline.all().some((e) => e.relPath === 'src/lf.ts'), 5000);
  await until('lf create playback', idle);
  assert.equal(mirrorDoc('src/lf.ts')?.eol, vscode.EndOfLine.LF, 'LF file took the CRLF default');
  assert.equal(mirrorText('src/lf.ts'), disk('src/lf.ts'));
  console.log('[it] line endings ok');

  // --- 8. Write order comes from modification times, not watcher arrival.
  // y.ts is written and reported first; x.ts is written after that report but
  // its mtime says it was written earlier, so the timeline and replay must put
  // x.ts first. A wide window keeps the mtime clamp out of the way on slow watchers.
  const reorderWindow = Number(process.env.IT_REORDER_WINDOW_MS ?? 5000);
  await vscode.workspace.getConfiguration('agentTypewriter').update('reorderWindowMs', reorderWindow, vscode.ConfigurationTarget.Workspace);
  const beforeOrder = timeline.all().length;
  const seen = new Set<string>();
  const probe = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(root, 'src/*.ts'));
  probe.onDidCreate((u) => seen.add(path.basename(u.fsPath)));
  write('src/y.ts', 'export const y = 1;\n');
  await until('watcher to report y.ts', () => seen.has('y.ts'), 10000);
  probe.dispose();
  write('src/x.ts', 'export const x = 1;\n');
  const xWritten = new Date(fs.statSync(path.join(root, 'src/y.ts')).mtimeMs - 20);
  fs.utimesSync(path.join(root, 'src/x.ts'), xWritten, xWritten);
  await until('x and y recorded', () => timeline.all().length >= beforeOrder + 2, 20000);
  await until('x and y playback', idle);
  const recorded = timeline.all().slice(beforeOrder).map((e) => e.relPath);
  assert.deepEqual(recorded, ['src/x.ts', 'src/y.ts'], 'changes not ordered by write time');
  order.length = 0;
  lastSeq = -1;
  await vscode.commands.executeCommand('agentTypewriter.replayFrom', timeline.all()[beforeOrder].seq);
  await sleep(200);
  await until('write-order replay', idle);
  assert.deepEqual(order, ['src/x.ts', 'src/y.ts'], 'replay not in write order');
  console.log('[it] write order ok');

  // --- 9. An outside write right after an own save is still recorded, from the saved text.
  const lf = (t: string) => t.replace(/\r\n/g, '\n');
  async function saveThenWrite(marker: string, gapMs: number) {
    const at = timeline.all().length;
    const d = await vscode.workspace.openTextDocument(path.join(root, 'src/existing.ts'));
    const e = await vscode.window.showTextDocument(d);
    await e.edit((b) => b.insert(new vscode.Position(0, 0), `// ${marker} by me\n`));
    await d.save();
    const savedText = lf(d.getText());
    if (gapMs > 0) await sleep(gapMs);
    // Windows can hold the file briefly right after a save (EBUSY); retry like an agent would.
    for (let tries = 0; ; tries++) {
      try {
        write('src/existing.ts', savedText + `export const ${marker} = 'agent';\n`);
        break;
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        if ((code !== 'EBUSY' && code !== 'EPERM') || tries >= 50) throw err;
        await sleep(20);
      }
    }
    await until(`${marker} recorded`, () => timeline.all().length > at, 20000);
    await sleep(500);
    await until(`${marker} playback`, idle);
    const added = timeline.all().slice(at);
    assert.equal(added.length, 1, `expected one change, got ${added.map((x) => `${x.kind} ${x.relPath}`).join(', ')}`);
    assert.equal(added[0].before, savedText, `${marker}: before text is not the saved text`);
    assert.equal(added[0].after, lf(disk('src/existing.ts')), `${marker}: after text is not the disk text`);
    assert.equal(mirrorText('src/existing.ts'), disk('src/existing.ts'), `${marker}: mirror does not match disk`);
  }
  await saveThenWrite('rightAfter', 0);
  await saveThenWrite('later', 3000);
  console.log('[it] write after own save ok');

  // --- 10. Git-backed baselines: with no memory budget, a committed file's
  // first change is still replayed, from the committed text. Git is only read.
  const cfg = () => vscode.workspace.getConfiguration('agentTypewriter');
  const WS = vscode.ConfigurationTarget.Workspace;
  const gitState = () => {
    const head = fs.readFileSync(path.join(root, '.git/HEAD'), 'utf8');
    const ref = head.startsWith('ref: ') ? fs.readFileSync(path.join(root, '.git', head.slice(5).trim()), 'utf8') : '';
    return head + ref + fs.readFileSync(path.join(root, '.git/index')).toString('base64');
  };
  const gitBefore = gitState();
  const gitOn = process.env.IT_GIT_BASELINES !== '0';
  await cfg().update('baselineBudgetMB', 0, WS);
  await cfg().update('gitBaselines', gitOn, WS);
  await vscode.commands.executeCommand('agentTypewriter.stop');
  await vscode.commands.executeCommand('agentTypewriter.start');
  async function firstChangeOf(rel: string, label: string) {
    const committed = lf(disk(rel));
    const at = timeline.all().length;
    write(rel, committed + `export const ${label} = 'agent';\n`);
    await until(`${label} recorded`, () => timeline.all().length > at, 20000);
    await sleep(300);
    await until(`${label} playback`, idle);
    const added = timeline.all().slice(at);
    assert.equal(added.length, 1, `${label}: expected one change, got ${added.length}`);
    assert.equal(added[0].before, committed, `${label}: before text is not the committed text`);
    assert.equal(mirrorText(rel), disk(rel), `${label}: mirror does not match disk`);
  }
  await firstChangeOf('src/committed1.ts', 'gitFirst');
  assert.equal(gitState(), gitBefore, 'git HEAD, ref or index changed');
  console.log('[it] git baselines ok');

  // --- 11. Toggling while watching. Off (with budget): baselines move to memory.
  // On (no budget): a file with no baseline gets one from git.
  const settle = () => sleep(1500);
  await cfg().update('baselineBudgetMB', 256, WS);
  await settle();
  await cfg().update('gitBaselines', false, WS);
  await settle();
  await firstChangeOf('src/committed2.ts', 'toggledOff');
  await cfg().update('baselineBudgetMB', 0, WS);
  await settle();
  await cfg().update('gitBaselines', true, WS);
  await settle();
  await firstChangeOf('src/committed3.ts', 'toggledOn');
  assert.equal(gitState(), gitBefore, 'git HEAD, ref or index changed');
  console.log('[it] git baseline toggling ok');

  // --- 12. Playback panel: locked-down HTML, seek keeps pause state, end of
  // the slider skips to latest, speed, and malformed messages do nothing.
  const { player, scrubber } = api;
  await vscode.commands.executeCommand('agentTypewriter.scrubber.focus');
  await until('playback panel to resolve', () => scrubber.isResolved, 10000);
  assert.match(scrubber.html, /default-src 'none'; style-src 'nonce-[0-9a-f]+'; script-src 'nonce-[0-9a-f]+';/);
  assert.doesNotMatch(scrubber.html, /https?:\/\//, 'panel HTML references remote content');
  await until('idle before panel checks', idle);
  if (!player.isPaused) await scrubber.receive({ type: 'togglePause' });
  assert.equal(player.isPaused, true, 'panel pause did not pause');
  const events = timeline.all();
  const target = events[1].seq;
  await scrubber.receive({ type: 'seek', seq: target });
  await sleep(300);
  assert.equal(timeline.cursor, target, 'seek did not move the cursor');
  assert.equal(player.isPaused, true, 'seek changed the pause state');
  assert.equal(timeline.stateOf(target), 'pending', 'played while paused');
  await scrubber.receive({ type: 'seek', seq: 'nope' });
  await scrubber.receive({ type: 'launchMissiles' });
  assert.equal(timeline.cursor, target, 'malformed message moved the cursor');
  await scrubber.receive({ type: 'togglePause' });
  assert.equal(player.isPaused, false);
  await until('playback after panel seek', () => timeline.stateOf(target) === 'played', 20000);
  await until('panel replay to drain', idle);
  await scrubber.receive({ type: 'togglePause' });
  await scrubber.receive({ type: 'seek', seq: target });
  await scrubber.receive({ type: 'seek', seq: events[events.length - 1].seq + 1 });
  assert.equal(timeline.pendingCount(), 0, 'seek to end left changes queued');
  assert.equal(mirrorText('src/a.ts'), disk('src/a.ts'), 'seek to end did not snap mirrors');
  // Skip to next while paused moves one change on; skipping the newest one is skip to latest.
  await scrubber.receive({ type: 'seek', seq: target });
  await scrubber.receive({ type: 'skipToNext' });
  assert.equal(timeline.cursor, events[2].seq, 'skip did not move to the next change');
  assert.equal(player.isPaused, true, 'skip changed the pause state');
  await scrubber.receive({ type: 'seek', seq: events[events.length - 1].seq });
  await scrubber.receive({ type: 'skipToNext' });
  assert.equal(timeline.pendingCount(), 0, 'skipping the newest change left changes queued');
  await scrubber.receive({ type: 'togglePause' });
  await scrubber.receive({ type: 'speed', value: 2 });
  assert.equal(player.speed, 2);
  await scrubber.receive({ type: 'speed', value: -1 });
  assert.equal(player.speed, 2, 'negative speed accepted');
  await scrubber.receive({ type: 'speed', value: 1 });
  console.log('[it] playback panel ok');

  // --- 13. Repository settings file: applies live, sits below workspace
  // settings, survives a broken save, and goes away with the file.
  const repoFile = path.join(root, '.agent-typewriter.json');
  const skipped = vscode.Uri.file(path.join(root, 'src/skip/a.ts'));
  const watched = () => api.recorder.matches(skipped);
  await cfg().update('baselineBudgetMB', 256, WS);
  fs.writeFileSync(repoFile, JSON.stringify({ exclude: ['src/skip/**'] }));
  await until('file exclude to apply', () => !watched(), 10000);
  const atRepo = timeline.all().length;
  fs.mkdirSync(path.join(root, 'src/skip'), { recursive: true });
  write('src/skip/a.ts', 'export const skip = 1;\n');
  await sleep(500);
  write('src/skip/a.ts', 'export const skip = 2;\n');
  await sleep(1000);
  assert.equal(timeline.all().length, atRepo, 'a path excluded by the repository file was recorded');

  // A workspace value overrides the file; the newly matching file gets a baseline.
  await cfg().update('exclude', [], WS);
  await until('workspace exclude to win', watched, 10000);
  await until('skip/a.ts baseline', () => api.recorder.hasBaseline(skipped), 20000);
  write('src/skip/a.ts', 'export const skip = 3;\n');
  await until('skip/a.ts recorded', () => timeline.all().slice(atRepo).some((e) => e.relPath === 'src/skip/a.ts'), 20000);
  await until('skip/a.ts playback', idle);
  const skipEvent = timeline.all().slice(atRepo).find((e) => e.relPath === 'src/skip/a.ts')!;
  assert.equal(skipEvent.kind, 'modify');
  assert.equal(skipEvent.before, 'export const skip = 2;\n');

  // Reset Filters clears workspace values, so the file applies again.
  await vscode.commands.executeCommand('agentTypewriter.resetFilters');
  await until('reset to fall back to the file', () => !watched(), 10000);

  // A broken save keeps the previous values; deleting the file drops them.
  fs.writeFileSync(repoFile, '{ "exclude": [');
  await sleep(1500);
  assert.equal(watched(), false, 'a broken repository file dropped its previous values');
  const atDelete = timeline.all().length;
  fs.unlinkSync(repoFile);
  await until('deleted file to stop applying', watched, 10000);
  // With extensions reset, the file itself is watched; let its delete land and play.
  await until('repo file delete recorded', () => timeline.all().slice(atDelete).some((e) => e.relPath === '.agent-typewriter.json' && e.kind === 'delete'), 20000);
  await until('repo file delete playback', idle);
  console.log('[it] repository settings file ok');

  // --- 14. Opening the settings file when there is none writes nothing.
  await vscode.commands.executeCommand('agentTypewriter.openRepoSettings');
  const opened = vscode.window.activeTextEditor?.document;
  assert.equal(opened?.uri.scheme, 'untitled', 'expected an untitled editor');
  assert.equal(path.basename(opened!.uri.fsPath), '.agent-typewriter.json');
  assert.deepEqual(Object.keys(JSON.parse(opened!.getText())), ['include', 'exclude', 'extensions']);
  assert.equal(fs.existsSync(repoFile), false, 'opening the settings file wrote it');
  await vscode.commands.executeCommand('workbench.action.revertAndCloseActiveEditor');
  console.log('[it] open repository settings file ok');

  // --- 15. respectGitignore: ignored new files are skipped, tracked files are
  // not, .gitignore edits apply live, and turning it off records from a baseline.
  const uriOf = (rel: string) => vscode.Uri.file(path.join(root, rel));
  const eventsFor = (rel: string, from: number) => timeline.all().slice(from).filter((e) => e.relPath === rel);
  fs.mkdirSync(path.join(root, 'src/later'), { recursive: true });
  // Give the watcher time to pick up the new directory (Linux misses files created right away).
  await sleep(1000);
  const atLater = timeline.all().length;
  write('src/later/a.ts', 'export const later = 1;\n');
  await until('later/a.ts recorded', () => eventsFor('src/later/a.ts', atLater).length === 1, 20000);
  write('.gitignore', '*.gen.ts\n*.cfg\n');
  await cfg().update('respectGitignore', true, WS);
  await until('gitignore rules to apply', () => api.recorder.describeFilter().includes('not gitignored'), 10000);
  await sleep(500);

  const atIgnore = timeline.all().length;
  write('src/new.gen.ts', 'export const generated = 1;\n');
  write('src/tracked.cfg', 'level = 2\n');
  await until('tracked.cfg recorded', () => eventsFor('src/tracked.cfg', atIgnore).length === 1, 20000);
  await sleep(1000);
  assert.equal(eventsFor('src/tracked.cfg', atIgnore)[0].kind, 'modify', 'a tracked file matching a pattern was not recorded as a modify');
  assert.equal(eventsFor('src/new.gen.ts', atIgnore).length, 0, 'a new gitignored file was recorded');

  write('.gitignore', '*.gen.ts\n*.cfg\nsrc/later/\n');
  await until('.gitignore edit to apply', () => !api.recorder.matches(uriOf('src/later/a.ts')), 10000);
  const atLive = timeline.all().length;
  write('src/later/a.ts', 'export const later = 2;\n');
  await sleep(1500);
  assert.equal(eventsFor('src/later/a.ts', atLive).length, 0, 'a path ignored by an edited .gitignore was recorded');

  await cfg().update('respectGitignore', false, WS);
  await until('gitignore rules to clear', () => api.recorder.matches(uriOf('src/later/a.ts')), 10000);
  await until('later/a.ts baseline', () => api.recorder.hasBaseline(uriOf('src/later/a.ts')), 20000);
  write('src/later/a.ts', 'export const later = 3;\n');
  await until('later/a.ts recorded again', () => eventsFor('src/later/a.ts', atLive).length === 1, 20000);
  const again = eventsFor('src/later/a.ts', atLive)[0];
  assert.equal(again.kind, 'modify');
  assert.equal(again.before, 'export const later = 2;\n', 'turning respectGitignore off did not take a baseline');
  await until('gitignore playback', idle);
  console.log('[it] respectGitignore ok');

  // --- 16. Filter profiles: switching to a file-defined profile clears the
  // workspace values it sets, "No profile" goes back, and saving activates.
  const profileOn = (name: string) => api.recorder.describeFilter().startsWith(`${name}: `);
  await cfg().update('extensions', ['ts'], WS);
  fs.writeFileSync(repoFile, JSON.stringify({ profiles: { docs: { include: ['docs/**'], extensions: ['md'] } } }));
  // The switch reads a just-written file itself when it doesn't know the profile yet.
  await vscode.commands.executeCommand('agentTypewriter.switchProfile', 'docs');
  await until('docs profile active', () => profileOn('docs'), 10000);
  assert.equal(cfg().inspect('extensions')?.workspaceValue, undefined, 'switching did not clear the workspace extensions');
  assert.equal(cfg().inspect('activeProfile')?.workspaceValue, 'docs');
  fs.mkdirSync(path.join(root, 'docs'), { recursive: true });
  await sleep(1000);
  const atProfile = timeline.all().length;
  write('src/profiled.ts', 'export const profiled = 1;\n');
  write('docs/guide.md', '# Guide\n');
  await until('docs/guide.md recorded', () => eventsFor('docs/guide.md', atProfile).length === 1, 20000);
  await sleep(1000);
  assert.equal(eventsFor('src/profiled.ts', atProfile).length, 0, 'a path outside the active profile was recorded');

  await vscode.commands.executeCommand('agentTypewriter.switchProfile', '');
  await until('no profile', () => !profileOn('docs'), 10000);
  assert.ok(api.recorder.matches(uriOf('src/profiled.ts')), '"No profile" did not restore the filters');

  // Saving keeps other stored entries exactly as written, even ones that don't validate.
  const handWritten = { keep: { include: ['x/**'], exlude: ['typo'] }, draft: 'tbd' };
  await cfg().update('profiles', handWritten, WS);
  await vscode.commands.executeCommand('agentTypewriter.saveProfile', 'mine');
  await until('saved profile active', () => profileOn('mine'), 10000);
  const stored = cfg().inspect('profiles')?.workspaceValue as Record<string, unknown>;
  assert.deepEqual((stored?.mine as { include: string[] })?.include, ['**/*'], 'saved profile does not hold the current include');
  assert.deepEqual({ keep: stored?.keep, draft: stored?.draft }, handWritten, 'saving rewrote other profile entries');
  // With every file watched, the settings writes above are recorded too, up to a
  // reorder window later. Wait until nothing new arrives for a full window, so
  // the reload check below sees only its own queued changes.
  for (let n = -1; n !== timeline.all().length; ) {
    n = timeline.all().length;
    await sleep(reorderWindow + 1500);
  }
  await until('profile playback', idle);
  console.log(`[it] filter profiles ok (settled at ${timeline.all().length} changes, last: ${timeline.all().at(-1)?.relPath})`);

  // --- 17. Worktrees: a nested worktree is not recorded by default, a chosen
  // sibling worktree is recorded under its label into its own mirror,
  // switching back keeps queued changes, a worktree added while recording is
  // skipped, and removing the chosen worktree falls back to the folder's own.
  const folder = vscode.workspace.workspaceFolders![0];
  const nestedDir = path.join(root, '.worktrees', 'nested');
  const siblingDir = `${root}-sibling`;
  const label = path.basename(siblingDir);
  const gitIn = (cwd: string, ...args: string[]) =>
    execFileSync('git', ['-c', 'user.name=it', '-c', 'user.email=it@example.invalid', ...args], { cwd, stdio: 'ignore' });
  const own = () => api.recorder.checkoutOf(folder)?.own;
  const choose = (p: string) => vscode.commands.executeCommand('agentTypewriter.chooseCheckout', folder.uri, p);
  const since = (from: number) => timeline.all().slice(from);
  await until('nested worktree skipped', () => api.recorder.describeFilter().includes('other worktrees skipped'), 10000);

  const atNested = timeline.all().length;
  fs.writeFileSync(path.join(nestedDir, 'src', 'committed1.ts'), 'export const inNested = 1;\n');
  fs.writeFileSync(path.join(nestedDir, 'src', 'brandNew.ts'), 'export const brandNew = 1;\n');
  write('src/mainSide.ts', 'export const mainSide = 1;\n');
  await until('main checkout write recorded', () => eventsFor('src/mainSide.ts', atNested).length === 1, 20000);
  await sleep(1500);
  assert.deepEqual(
    since(atNested).map((e) => e.relPath),
    ['src/mainSide.ts'],
    'a write inside a nested worktree was recorded',
  );
  await until('nested playback', idle);

  // A nested repository that is not a worktree of this one is recorded as usual,
  // once git has said so (its new .git hides it until then).
  // One level deep: Linux watchers can miss a directory created inside another new one.
  const otherRepo = path.join(root, 'otherRepo');
  fs.mkdirSync(otherRepo);
  await sleep(1000);
  gitIn(otherRepo, 'init', '-q');
  await sleep(2000);
  const atOther = timeline.all().length;
  fs.writeFileSync(path.join(otherRepo, 'other.ts'), 'export const other = 1;\n');
  await until('nested repository write recorded', () => eventsFor('otherRepo/other.ts', atOther).length === 1, 20000);
  await until('nested repository playback', idle);

  // Choose the sibling: its first change is a modify from its baseline, under its label.
  await choose(siblingDir);
  await until('sibling chosen', () => own() === false, 20000);
  assert.equal(api.recorder.checkoutOf(folder)?.name, 'sibling');
  const siblingFile = (rel: string) => [siblingDir, fs.realpathSync.native(siblingDir)].map((d) => vscode.Uri.file(path.join(d, rel)));
  await until('sibling baseline', () => siblingFile('src/committed1.ts').some((u) => api.recorder.hasBaseline(u)), 20000);
  const committedText = lf(fs.readFileSync(path.join(siblingDir, 'src', 'committed1.ts'), 'utf8'));
  const atSibling = timeline.all().length;
  fs.writeFileSync(path.join(siblingDir, 'src', 'committed1.ts'), committedText + "export const inSibling = 'agent';\n");
  write('src/committed2.ts', lf(disk('src/committed2.ts')) + "export const mainWhileSibling = 1;\n");
  const siblingRel = `${label}/src/committed1.ts`;
  await until('sibling change recorded', () => eventsFor(siblingRel, atSibling).length === 1, 20000);
  await sleep(1500);
  assert.deepEqual(since(atSibling).map((e) => e.relPath), [siblingRel], 'expected only the sibling change');
  assert.equal(since(atSibling)[0].kind, 'modify');
  assert.equal(since(atSibling)[0].before, committedText, 'sibling change does not start from its baseline');
  await until('sibling playback', idle);
  assert.equal(mirrorText(siblingRel), fs.readFileSync(path.join(siblingDir, 'src', 'committed1.ts'), 'utf8'));
  assert.notEqual(mirrorText('src/committed1.ts'), mirrorText(siblingRel), 'checkouts share a mirror');

  // Switch back while a sibling change is queued: it still plays.
  if (!player.isPaused) await vscode.commands.executeCommand('agentTypewriter.togglePause');
  const atQueue = timeline.all().length;
  fs.writeFileSync(path.join(siblingDir, 'src', 'committed1.ts'), committedText + "export const queuedInSibling = 'agent';\n");
  await until('queued sibling change', () => eventsFor(siblingRel, atQueue).length === 1, 20000);
  await choose('');
  await until('own checkout again', () => own() === true, 20000);
  assert.equal(timeline.pendingCount(), 1, 'switching checkouts dropped a queued change');
  await vscode.commands.executeCommand('agentTypewriter.togglePause');
  await until('queued sibling playback', idle);
  const atBack = timeline.all().length;
  write('src/mainSide.ts', 'export const mainSide = 2;\n');
  await until('main recorded after switching back', () => eventsFor('src/mainSide.ts', atBack).length === 1, 20000);
  assert.equal(eventsFor('src/mainSide.ts', atBack)[0].kind, 'modify');
  await until('switch-back playback', idle);

  // A worktree added inside the folder while recording: its checkout and later writes are skipped.
  const atLate = timeline.all().length;
  gitIn(root, 'worktree', 'add', '-q', '-b', 'late', '.worktrees/late');
  await sleep(1500);
  fs.writeFileSync(path.join(root, '.worktrees', 'late', 'src', 'lateWrite.ts'), 'export const late = 1;\n');
  await sleep(2000);
  // Changes are held for the reorder window; release them so a wrongly recorded one shows up here.
  api.recorder.drainHeld();
  assert.deepEqual(
    since(atLate).map((e) => e.relPath),
    [],
    'a worktree added while recording was recorded',
  );

  // Removing the chosen worktree falls back to the folder's own checkout and forgets the choice.
  await choose(siblingDir);
  await until('sibling chosen again', () => own() === false, 20000);
  // A refresh that keeps the same root hands the watcher to a new scope; the fallback must still work.
  await api.recorder.refreshFilter();
  const atRemove = timeline.all().length;
  gitIn(root, 'worktree', 'remove', '--force', siblingDir);
  await until('fallback to own checkout', () => own() === true, 20000);
  assert.equal((await api.recorder.checkoutsOf(folder))?.chosen, undefined, 'the removed worktree is still remembered');
  await sleep(1000);
  api.recorder.drainHeld();
  assert.deepEqual(
    since(atRemove).map((e) => `${e.kind} ${e.relPath}`),
    [],
    'removing the chosen worktree recorded its files as deleted',
  );
  await until('worktree playback', idle);
  console.log('[it] worktrees ok');

  // Review fix groups add their sections directly below their own anchor, so
  // branches worked on in parallel merge cleanly. Later recorder groups use
  // REC1's. Remove the anchors once the review groups have merged.
  // --- review group PLAY

  // --- review group SET

  // --- review group ACT

  // --- review group REC1
  {
    // Settings these sections change; restored at the end for the sections below.
    const restoreExtensions = cfg().inspect('extensions')?.workspaceValue;
    const setting = async (key: string, value: unknown) => {
      await cfg().update(key, value, WS);
      await sleep(200);
    };
    const relEvents = (from: number) => since(from).map((e) => `${e.kind} ${e.relPath}`);
    const created = async (rel: string, text: string) => {
      const at = timeline.all().length;
      write(rel, text);
      await until(`${rel} recorded`, () => eventsFor(rel, at).length > 0, 20000);
      await until(`${rel} baseline`, () => api.recorder.hasBaseline(uriOf(rel)), 20000);
      await until(`${rel} playback`, idle);
    };
    const settled = async () => {
      await sleep(1000);
      api.recorder.drainHeld();
      await until('playback to settle', idle);
    };
    await setting('extensions', ['ts']);

    // R1. A delete is ordered by its own watcher event, not by the earlier
    // write it was merged with. Runs with the wide reorder window from step 8.
    // The long debounce merges delA's write and delete into one burst; delB is
    // written only once the watcher has reported that write.
    await setting('debounceMs', 1500);
    await created('src/delA.ts', 'export const delA = 1;\n');
    const atDelete = timeline.all().length;
    let delAReported = false;
    const delProbe = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(root, 'src/delA.ts'));
    delProbe.onDidChange(() => (delAReported = true));
    write('src/delA.ts', 'export const delA = 2;\n');
    await until('watcher to report the delA write', () => delAReported, 10000);
    delProbe.dispose();
    await sleep(50);
    write('src/delB.ts', 'export const delB = 1;\n');
    await sleep(50);
    fs.unlinkSync(path.join(root, 'src/delA.ts'));
    const deleteOf = (rel: string) => since(atDelete).find((e) => e.relPath === rel && e.kind === 'delete');
    await until('delB and the delete of delA recorded', () => !!deleteOf('src/delA.ts') && eventsFor('src/delB.ts', atDelete).length === 1);
    const order1 = relEvents(atDelete);
    assert.ok(order1.indexOf('create src/delB.ts') < order1.indexOf('delete src/delA.ts'), `delete ordered before an earlier write: ${order1.join(', ')}`);
    assert.ok(deleteOf('src/delA.ts')!.time >= eventsFor('src/delB.ts', atDelete)[0].time, 'delete time is before an earlier write');
    await settled();
    await setting('debounceMs', 100);
    await setting('reorderWindowMs', 0);
    console.log('[it] delete keyed at its own event ok');

    // R2. Two reads of one file never overlap, so every change starts where the last one ended.
    const assertChain = (rel: string, from: number, first: string, last: string) => {
      let text = first;
      for (const e of eventsFor(rel, from)) {
        assert.equal(e.before, text, `${rel}: a change does not start where the previous one ended`);
        text = e.after;
      }
      assert.equal(text, last, `${rel}: the changes do not end at the disk text`);
      assert.equal(mirrorText(rel), disk(rel), `${rel}: mirror does not match disk`);
    };
    // Quick writes with no debounce.
    await created('src/chain.ts', 'export const v = 0;\n');
    await setting('debounceMs', 0);
    const atChain = timeline.all().length;
    for (let i = 1; i <= 6; i++) {
      write('src/chain.ts', `export const v = ${i};\n`);
      await sleep(i % 2 === 0 ? 60 : 10);
    }
    await until('last chain write recorded', () => eventsFor('src/chain.ts', atChain).at(-1)?.after === 'export const v = 6;\n');
    await settled();
    assertChain('src/chain.ts', atChain, 'export const v = 0;\n', 'export const v = 6;\n');
    await setting('debounceMs', 200);
    // A read waiting on a save that never finishes, and a second burst of the
    // same file whose timer fires meanwhile.
    await created('src/chain2.ts', 'export const w = 0;\n');
    const chainPath = path.join(root, 'src/chain2.ts');
    const chainDoc = await vscode.workspace.openTextDocument(chainPath);
    const chainEd = await vscode.window.showTextDocument(chainDoc);
    await chainEd.edit((b) => b.insert(new vscode.Position(0, 0), '// unsaved by me\n'));
    fs.chmodSync(chainPath, 0o444);
    const chainSaved = await chainDoc.save();
    fs.chmodSync(chainPath, 0o644);
    assert.equal(chainSaved, false, 'expected the save of a read-only file to fail');
    const atChain2 = timeline.all().length;
    write('src/chain2.ts', 'export const w = 1;\n');
    await sleep(300);
    write('src/chain2.ts', 'export const w = 2;\n');
    await until('last chain2 write recorded', () => eventsFor('src/chain2.ts', atChain2).at(-1)?.after === 'export const w = 2;\n');
    await settled();
    await vscode.window.showTextDocument(chainDoc);
    await vscode.commands.executeCommand('workbench.action.revertAndCloseActiveEditor');
    assertChain('src/chain2.ts', atChain2, 'export const w = 0;\n', 'export const w = 2;\n');
    await setting('debounceMs', 100);
    console.log(`[it] same-file changes chain ok (${eventsFor('src/chain.ts', atChain).length} and ${eventsFor('src/chain2.ts', atChain2).length} changes)`);

    // R3. A save that fails (here the file is read-only) is not the next
    // outside write's before text.
    await created('src/failedSave.ts', 'export const s = 0;\n');
    const failPath = path.join(root, 'src/failedSave.ts');
    const failDoc = await vscode.workspace.openTextDocument(failPath);
    const failEd = await vscode.window.showTextDocument(failDoc);
    await failEd.edit((b) => b.insert(new vscode.Position(0, 0), '// unsaved by me\n'));
    fs.chmodSync(failPath, 0o444);
    const savedOk = await failDoc.save();
    fs.chmodSync(failPath, 0o644);
    assert.equal(savedOk, false, 'expected the save of a read-only file to fail');
    await vscode.window.showTextDocument(failDoc);
    await vscode.commands.executeCommand('workbench.action.revertAndCloseActiveEditor');
    const atAfterFail = timeline.all().length;
    write('src/failedSave.ts', 'export const s = 1;\n');
    await until('write after a failed save recorded', () => eventsFor('src/failedSave.ts', atAfterFail).length === 1);
    await settled();
    const afterFail = eventsFor('src/failedSave.ts', atAfterFail);
    assert.equal(afterFail.length, 1);
    assert.equal(afterFail[0].before, 'export const s = 0;\n', 'a failed save became the before text');
    console.log('[it] failed save ok');

    // R4. A save of a file that is not recorded leaves nothing behind: once the
    // file is recorded, its change starts from its baseline, not the saved text.
    write('notes.md', 'start\n');
    await sleep(300);
    assert.equal(api.recorder.matches(uriOf('notes.md')), false);
    const mdDoc = await vscode.workspace.openTextDocument(path.join(root, 'notes.md'));
    const mdEd = await vscode.window.showTextDocument(mdDoc);
    await mdEd.edit((b) => b.replace(new vscode.Range(0, 0, mdDoc.lineCount, 0), 'U user\n'));
    await mdDoc.save();
    await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
    write('notes.md', 'A agent\n');
    await sleep(500);
    const atMd = timeline.all().length;
    await setting('extensions', ['ts', 'md']);
    await until('notes.md baseline', () => api.recorder.hasBaseline(uriOf('notes.md')), 20000);
    write('notes.md', 'A2 agent\n');
    await until('notes.md recorded', () => eventsFor('notes.md', atMd).length > 0);
    await settled();
    assert.deepEqual(
      eventsFor('notes.md', atMd).map((e) => [e.kind, e.before]),
      [['modify', 'A agent\n']],
      'a save made while the file was filtered out became its before text',
    );
    await setting('extensions', ['ts']);
    console.log('[it] own saves of unrecorded files ok');

    // R5. Saving through a symlink is an own save of the file it leads to.
    await created('src/linkTarget.ts', 'export const target = 1;\n');
    fs.mkdirSync(path.join(root, 'src/linkDirReal'));
    await sleep(1000);
    await created('src/linkDirReal/a.ts', 'export const inLinkedDir = 1;\n');
    let linked = true;
    try {
      fs.symlinkSync('linkTarget.ts', path.join(root, 'src/linkFile.ts'), 'file');
      fs.symlinkSync('linkDirReal', path.join(root, 'src/linkDir'), 'dir');
    } catch (err) {
      linked = false;
      console.log(`[it] symlinks unavailable here (${(err as NodeJS.ErrnoException).code}); skipping the symlink save check`);
    }
    if (linked) {
      await settled();
      const saveVia = async (rel: string) => {
        const d = await vscode.workspace.openTextDocument(path.join(root, rel));
        const e = await vscode.window.showTextDocument(d);
        await e.edit((b) => b.insert(new vscode.Position(0, 0), '// saved through a link\n'));
        await d.save();
        const text = lf(d.getText());
        await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
        return text;
      };
      const atLink = timeline.all().length;
      const linkSaved = await saveVia('src/linkFile.ts');
      await saveVia('src/linkDir/a.ts');
      await settled();
      assert.deepEqual(relEvents(atLink), [], 'a save through a symlink was recorded');
      write('src/linkTarget.ts', linkSaved + "export const agent = 'agent';\n");
      await until('write to the link target recorded', () => eventsFor('src/linkTarget.ts', atLink).length > 0);
      await settled();
      const targetEvents = eventsFor('src/linkTarget.ts', atLink);
      assert.equal(targetEvents.length, 1);
      assert.equal(targetEvents[0].before, linkSaved, 'the write after a save through a link does not start from the saved text');
      console.log('[it] saves through symlinks ok');
    }

    // R6. Deleting a directory deletes each recorded file in it.
    // One level at a time: Linux watchers can miss a directory created inside another new one.
    fs.mkdirSync(path.join(root, 'src/olddir'));
    await sleep(1000);
    fs.mkdirSync(path.join(root, 'src/olddir/sub'));
    await sleep(1000);
    const oldFiles = ['src/olddir/a.ts', 'src/olddir/b.ts', 'src/olddir/sub/c.ts'];
    for (const rel of oldFiles) await created(rel, `export const f = '${rel}';\n`);
    const watchedBefore = api.recorder.watchedCount;
    const atRm = timeline.all().length;
    fs.rmSync(path.join(root, 'src/olddir'), { recursive: true });
    await until('a delete per file', () => oldFiles.every((rel) => eventsFor(rel, atRm).some((e) => e.kind === 'delete')));
    await settled();
    for (const rel of oldFiles) {
      assert.deepEqual(eventsFor(rel, atRm).map((e) => [e.kind, e.before]), [['delete', `export const f = '${rel}';\n`]], `${rel}: expected one delete`);
      assert.equal(api.recorder.hasBaseline(uriOf(rel)), false, `${rel} kept its baseline`);
      assert.equal(mirrorText(rel), '', `${rel}: mirror not emptied`);
    }
    assert.equal(api.recorder.watchedCount, watchedBefore - oldFiles.length);

    // A renamed directory is a delete of each old path and a create of each new one.
    fs.mkdirSync(path.join(root, 'src/mv1'));
    await sleep(1000);
    for (const n of ['c', 'd']) await created(`src/mv1/${n}.ts`, `export const ${n} = 1;\n`);
    const atMv = timeline.all().length;
    fs.renameSync(path.join(root, 'src/mv1'), path.join(root, 'src/mv2'));
    const mvExpected = ['delete src/mv1/c.ts', 'delete src/mv1/d.ts', 'create src/mv2/c.ts', 'create src/mv2/d.ts'];
    await until('rename recorded', () => mvExpected.every((x) => relEvents(atMv).includes(x)));
    await settled();
    assert.deepEqual([...relEvents(atMv)].sort(), [...mvExpected].sort(), 'a directory rename is not one delete and one create per file');
    assert.ok(api.recorder.hasBaseline(uriOf('src/mv2/c.ts')), 'a moved file has no baseline');
    const atMvEdit = timeline.all().length;
    write('src/mv2/c.ts', 'export const c = 2;\n');
    await until('edit of a moved file recorded', () => eventsFor('src/mv2/c.ts', atMvEdit).length === 1);
    assert.equal(eventsFor('src/mv2/c.ts', atMvEdit)[0].kind, 'modify');
    assert.equal(eventsFor('src/mv2/c.ts', atMvEdit)[0].before, 'export const c = 1;\n');

    // A tree prepared outside the workspace and moved in records a create per file, nested ones too.
    const outside = `${root}-pkg`;
    fs.mkdirSync(path.join(outside, 'inner'), { recursive: true });
    fs.writeFileSync(path.join(outside, 'x.ts'), 'export const x = 1;\n');
    fs.writeFileSync(path.join(outside, 'inner', 'y.ts'), 'export const y = 1;\n');
    fs.writeFileSync(path.join(outside, 'inner', 'skip.txt'), 'not recorded\n');
    const atPkg = timeline.all().length;
    fs.renameSync(outside, path.join(root, 'src/pkg'));
    await until('moved-in tree recorded', () => ['src/pkg/x.ts', 'src/pkg/inner/y.ts'].every((rel) => eventsFor(rel, atPkg).length > 0));
    await settled();
    assert.deepEqual([...relEvents(atPkg)].sort(), ['create src/pkg/inner/y.ts', 'create src/pkg/x.ts']);
    console.log('[it] directory delete and rename ok');

    // R7. A file replaced by a directory of the same name is deleted.
    await created('src/thing.ts', 'file text\n');
    const atThing = timeline.all().length;
    fs.unlinkSync(path.join(root, 'src/thing.ts'));
    fs.mkdirSync(path.join(root, 'src/thing.ts'));
    write('src/thing.ts/inner.ts', 'export const inner = 1;\n');
    await until('replaced file deleted', () => eventsFor('src/thing.ts', atThing).some((e) => e.kind === 'delete'));
    await settled();
    assert.deepEqual(eventsFor('src/thing.ts', atThing).map((e) => [e.kind, e.before]), [['delete', 'file text\n']]);
    assert.equal(mirrorText('src/thing.ts'), '', 'the replaced file mirror was not emptied');
    assert.equal(api.recorder.hasBaseline(uriOf('src/thing.ts')), false, 'the replaced file kept its baseline');
    const atBack2 = timeline.all().length;
    fs.rmSync(path.join(root, 'src/thing.ts'), { recursive: true });
    await sleep(500);
    write('src/thing.ts', 'brand new\n');
    await until('file at the old path again', () => eventsFor('src/thing.ts', atBack2).length > 0);
    await settled();
    assert.deepEqual(eventsFor('src/thing.ts', atBack2).map((e) => [e.kind, e.before]), [['create', '']]);
    console.log('[it] file replaced by a directory ok');

    // R8. A case-only rename deletes the old spelling, also on case-insensitive filesystems.
    await created('src/CaseName.ts', 'export const caseName = 1;\n');
    const watchedCase = api.recorder.watchedCount;
    const atCase = timeline.all().length;
    fs.renameSync(path.join(root, 'src/CaseName.ts'), path.join(root, 'src/casename.ts'));
    await until('case rename recorded', () => ['delete src/CaseName.ts', 'create src/casename.ts'].every((x) => relEvents(atCase).includes(x)));
    await settled();
    assert.deepEqual([...relEvents(atCase)].sort(), ['create src/casename.ts', 'delete src/CaseName.ts']);
    assert.equal(api.recorder.hasBaseline(uriOf('src/CaseName.ts')), false, 'the old spelling kept its baseline');
    assert.equal(api.recorder.watchedCount, watchedCase, 'a case-only rename grew the watched count');
    assert.equal(mirrorText('src/CaseName.ts'), '', 'the old spelling mirror was not emptied');
    console.log('[it] case-only rename ok');

    // R9. A read in flight when recording stops writes nothing, so the next
    // session starts from the disk text at restart.
    await created('src/stopFlush.ts', 'C0\n');
    const holdSave = vscode.workspace.onWillSaveTextDocument((e) => {
      if (path.basename(e.document.uri.fsPath) === 'stopFlush.ts') e.waitUntil(sleep(800));
    });
    const stopDoc = await vscode.workspace.openTextDocument(path.join(root, 'src/stopFlush.ts'));
    const stopEd = await vscode.window.showTextDocument(stopDoc);
    await stopEd.edit((b) => b.insert(new vscode.Position(0, 0), '// mine\n'));
    const saving = stopDoc.save();
    await sleep(50);
    write('src/stopFlush.ts', 'C1\n');
    // The debounce fires and the read waits on the save that is still running.
    await sleep(400);
    await vscode.commands.executeCommand('agentTypewriter.stop');
    const atStop = timeline.all().length;
    await saving;
    holdSave.dispose();
    await sleep(1300);
    assert.equal(api.recorder.watchedCount, 0, 'a read in flight at stop stored a baseline');
    assert.equal(api.recorder.hasBaseline(uriOf('src/stopFlush.ts')), false);
    assert.equal(timeline.all().length, atStop, 'a read in flight at stop recorded a change');
    await vscode.window.showTextDocument(stopDoc);
    await vscode.commands.executeCommand('workbench.action.revertAndCloseActiveEditor');
    write('src/stopFlush.ts', 'C2\n');
    await sleep(100);
    await vscode.commands.executeCommand('agentTypewriter.start');
    await until('stopFlush.ts baseline after restart', () => api.recorder.hasBaseline(uriOf('src/stopFlush.ts')), 20000);
    const atRestart = timeline.all().length;
    write('src/stopFlush.ts', 'C3\n');
    await until('first change after restart', () => eventsFor('src/stopFlush.ts', atRestart).length > 0);
    await settled();
    assert.deepEqual(eventsFor('src/stopFlush.ts', atRestart).map((e) => [e.before, e.after]), [['C2\n', 'C3\n']]);
    console.log('[it] stop during a read ok');

    await cfg().update('extensions', restoreExtensions, WS);
    await cfg().update('reorderWindowMs', reorderWindow, WS);
    await sleep(500);
  }

  // --- 18. Leave two queued changes behind for the reload check in restore.ts,
  // which runs in a second VS Code launch on the same workspace.
  await until('idle before reload setup', idle);
  if (!api.player.isPaused) await vscode.commands.executeCommand('agentTypewriter.togglePause');
  const beforeQueue = timeline.all().length;
  write('src/queued1.ts', 'export const queued1 = 1;\n');
  await sleep(300);
  write('src/queued2.ts', 'export const queued2 = 2;\n');
  await until('queued changes recorded', () => timeline.all().length >= beforeQueue + 2, 20000);
  assert.equal(timeline.pendingCount(), 2, 'expected two queued changes');
  assert.ok(api.store, 'no timeline store');
  await api.store.flush();
  fs.writeFileSync(
    process.env.IT_EXPECT!,
    JSON.stringify({ events: timeline.all().map(persisted), pending: timeline.pendingCount() }),
  );
  console.log(`[it] left ${timeline.all().length} changes (2 queued) for the reload check`);
  // Stop first, so choosing only stores the choice; restore.ts checks it survives the reload.
  await vscode.commands.executeCommand('agentTypewriter.stop');
  await choose(nestedDir);
}

/** The recorded fields a restored change must keep. */
export function persisted(e: { relPath: string; uri: string; kind: string; before: string; after: string; eol: string; time: number }) {
  return { relPath: e.relPath, uri: e.uri, kind: e.kind, before: e.before, after: e.after, eol: e.eol, time: e.time };
}
