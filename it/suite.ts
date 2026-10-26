// Runs inside a real VS Code instance (see runTest.ts). Simulates an agent
// writing files from outside the editor and checks what the replay does.
import * as vscode from 'vscode';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import assert from 'node:assert/strict';
import type { AgentTypewriterApi } from '../src/extension';
import { baselines } from '../src/highlights';
import type { Timeline } from '../src/timeline';

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

// The sections run in four parts. IT_PART names one to run on its own, in a
// fresh workspace: runTest.ts gives each part a launch of its own, and CI a
// job of its own, starting from what the parts before it leave (startFrom).
// Only the reload part leaves state for restore.ts. Unset, every part runs in
// one launch.
const PARTS = { recording, playback, reload, edits } as const;

export async function run(): Promise<void> {
  const part = process.env.IT_PART as Part | undefined;
  if (part !== undefined && !Object.hasOwn(PARTS, part)) throw new Error(`unknown IT_PART ${part}`);
  const c = await setUp();
  if (part) {
    await startFrom(c, part, true);
    await PARTS[part](c);
  } else {
    for (const [name, run] of Object.entries(PARTS) as [Part, (c: Context) => Promise<void>][]) {
      await startFrom(c, name, false);
      await run(c);
    }
  }
  if (!part || part === 'reload') await leaveForReload(c);
}

type Part = keyof typeof PARTS;

/**
 * What the parts before `part` leave that its checks were written against:
 * settings (a CRLF files.eol, fast typing, a wide reorder window, the profile
 * section 16 saves, which watches every file, and the repository file), the
 * Playback panel section 12 opens, and for edits, ACT's history settings.
 * Running alone, a part starts by setting these up. In one launch they are
 * already so; checking that they are means a change to what an earlier part
 * leaves fails here instead of quietly changing what the later parts test.
 */
async function startFrom(c: Context, part: Part, alone: boolean): Promise<void> {
  if (part === 'recording') return;
  const { api, timeline, idle, scrubber, reorderWindow, cfg, WS, repoFile } = c;
  const exclude = cfg().inspect<string[]>('exclude')?.defaultValue;
  const workspace: [string, string, unknown][] = [
    ['files', 'eol', '\r\n'],
    ['agentTypewriter', 'charsPerMinute', 240000],
    ['agentTypewriter', 'reorderWindowMs', reorderWindow],
    ['agentTypewriter', 'baselineBudgetMB', 256],
    ['agentTypewriter', 'gitBaselines', true],
    ['agentTypewriter', 'respectGitignore', false],
    ['agentTypewriter', 'extensions', undefined],
    [
      'agentTypewriter',
      'profiles',
      {
        keep: { include: ['x/**'], exlude: ['typo'] },
        draft: 'tbd',
        mine: { include: ['**/*'], exclude, extensions: [], respectGitignore: false },
      },
    ],
    ['agentTypewriter', 'activeProfile', 'mine'],
  ];
  const user: [string, unknown][] = part === 'edits' ? [['historyLimit', 10], ['persistHistory', false]] : [];
  const docs = { docs: { include: ['docs/**'], extensions: ['md'] } };
  const file = part === 'edits' ? { profiles: docs, historyLimit: 1000, persistHistory: true } : { profiles: docs };
  if (alone) {
    fs.writeFileSync(repoFile, JSON.stringify(file));
    for (const [section, key, value] of workspace) await vscode.workspace.getConfiguration(section).update(key, value, WS);
    for (const [key, value] of user) await cfg().update(key, value, vscode.ConfigurationTarget.Global);
    await vscode.commands.executeCommand('agentTypewriter.scrubber.focus');
    await until('playback panel to resolve', () => scrubber.isResolved, 10000);
    await until('the saved profile to apply', () => api.recorder.describeFilter().startsWith('mine: '), 10000);
    // With every file watched, the writes above are recorded too, up to a
    // reorder window later; wait until nothing new arrives for a full window.
    for (let n = -1; n !== timeline.all().length; ) {
      n = timeline.all().length;
      await sleep(reorderWindow + 1500);
    }
    await until('setup changes to play', idle);
    return;
  }
  for (const [section, key, value] of workspace) {
    assert.deepEqual(vscode.workspace.getConfiguration(section).inspect(key)?.workspaceValue, value, `${part} starts from a different ${section}.${key}`);
  }
  for (const [key, value] of user) assert.deepEqual(cfg().inspect(key)?.globalValue, value, `${part} starts from a different user ${key}`);
  assert.deepEqual(JSON.parse(fs.readFileSync(repoFile, 'utf8')), file, `${part} starts from a different repository file`);
  assert.ok(scrubber.isResolved, `${part} starts without the Playback panel`);
}

/** Activates the extension, starts recording, and gathers what every part uses. */
async function setUp() {
  const ext = vscode.extensions.getExtension<AgentTypewriterApi>('burnzy1148.agent-typewriter');
  assert.ok(ext, 'extension not found');
  const api = await ext.activate();
  const { timeline } = api;
  const root = vscode.workspace.workspaceFolders![0].uri.fsPath;
  // On Windows another process (VS Code, git, a watcher) can briefly hold a file open; retry instead of failing.
  const write = (rel: string, text: string) => {
    for (let attempt = 0; ; attempt++) {
      try {
        return fs.writeFileSync(path.join(root, rel), text);
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        if ((code !== 'EBUSY' && code !== 'EPERM') || attempt >= 100) throw err;
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
      }
    }
  };
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


  // Helpers sections in more than one part use.
  const mirrorDoc = (rel: string) =>
    vscode.workspace.textDocuments.find((d) => d.uri.scheme === 'agent-typewriter' && d.uri.path === '/' + rel);
  const reorderWindow = Number(process.env.IT_REORDER_WINDOW_MS ?? 5000);
  const lf = (t: string) => t.replace(/\r\n/g, '\n');
  const cfg = () => vscode.workspace.getConfiguration('agentTypewriter');
  const WS = vscode.ConfigurationTarget.Workspace;
  const settle = () => sleep(1500);
  const { player, scrubber } = api;
  const repoFile = path.join(root, '.agent-typewriter.json');
  const uriOf = (rel: string) => vscode.Uri.file(path.join(root, rel));
  const eventsFor = (rel: string, from: number) => timeline.all().slice(from).filter((e) => e.relPath === rel);
  const folder = vscode.workspace.workspaceFolders![0];
  const nestedDir = path.join(root, '.worktrees', 'nested');
  const gitIn = (cwd: string, ...args: string[]) =>
    execFileSync('git', ['-c', 'user.name=it', '-c', 'user.email=it@example.invalid', ...args], { cwd, stdio: 'ignore' });
  const own = () => api.recorder.checkoutOf(folder)?.own;
  const choose = (p: string) => vscode.commands.executeCommand('agentTypewriter.chooseCheckout', folder.uri, p);
  const since = (from: number) => timeline.all().slice(from);

  await vscode.commands.executeCommand('agentTypewriter.start');
  await sleep(500);
  return {
    api,
    timeline,
    root,
    write,
    disk,
    mirrorText,
    idle,
    player,
    scrubber,
    reorderWindow,
    lf,
    cfg,
    WS,
    mirrorDoc,
    repoFile,
    settle,
    uriOf,
    eventsFor,
    folder,
    nestedDir,
    gitIn,
    own,
    choose,
    since,
  };
}

type Context = Awaited<ReturnType<typeof setUp>>;

/** Sections 1-17: live recording, filters, line endings, write order, git baselines, the playback panel, the repository settings file, and worktrees. */
async function recording(c: Context): Promise<void> {
  const {
    api,
    timeline,
    root,
    write,
    disk,
    mirrorText,
    idle,
    player,
    scrubber,
    reorderWindow,
    lf,
    cfg,
    WS,
    mirrorDoc,
    repoFile,
    settle,
    uriOf,
    eventsFor,
    folder,
    nestedDir,
    gitIn,
    own,
    choose,
    since,
  } = c;

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
  await vscode.workspace.getConfiguration('agentTypewriter').update('charsPerMinute', 1200, vscode.ConfigurationTarget.Workspace);
  write('src/b.ts', disk('src/b.ts') + '\n' + '// slow line that would take ages to type at 1200 cpm\n'.repeat(5));
  await until('slow change to start playing', () => timeline.all().some((e) => timeline.stateOf(e.seq) === 'playing'));
  await sleep(300);
  await vscode.commands.executeCommand('agentTypewriter.catchUp');
  assert.ok(idle(), 'still playing after catchUp');
  assert.equal(mirrorText('src/b.ts'), disk('src/b.ts'), 'catchUp did not snap mirror to latest');
  console.log('[it] catchUp ok');

  // --- 4. Deletion is recorded and replayed.
  await vscode.workspace.getConfiguration('agentTypewriter').update('charsPerMinute', 240000, vscode.ConfigurationTarget.Workspace);
  fs.unlinkSync(path.join(root, 'src/b.ts'));
  await until('delete event', () => timeline.all().some((e) => e.kind === 'delete'));
  await sleep(300);
  await until('delete playback', idle);
  assert.equal(mirrorText('src/b.ts'), '');
  console.log('[it] delete ok');

  // --- 4b. A rename is one change and moves the mirror (at-kbn.2).
  const mirrorTabOpen = (rel: string) =>
    vscode.window.tabGroups.all.flatMap((g) => g.tabs).some((t) => t.input instanceof vscode.TabInputText && t.input.uri.scheme === 'agent-typewriter' && t.input.uri.path === '/' + rel);
  write('src/moveme.ts', 'export const moved = true;\n');
  await until('moveme create', () => timeline.all().some((e) => e.relPath === 'src/moveme.ts'));
  await sleep(300);
  await until('moveme playback', idle);
  assert.ok(mirrorTabOpen('src/moveme.ts'), 'the created file has no mirror tab');
  const beforeRename = timeline.all().length;
  fs.renameSync(path.join(root, 'src/moveme.ts'), path.join(root, 'src/moved.ts'));
  await until('rename recorded', () => timeline.all().slice(beforeRename).some((e) => e.relPath === 'src/moved.ts'));
  // A stray half would arrive within the reorder window (2.5 s on Windows).
  await sleep(3000);
  await until('rename playback', idle);
  assert.deepEqual(
    timeline.all().slice(beforeRename).map((e) => `${e.kind} ${e.fromRelPath ?? ''} ${e.relPath}`),
    ['rename src/moveme.ts src/moved.ts'],
  );
  assert.equal(mirrorText('src/moved.ts'), disk('src/moved.ts'));
  assert.ok(mirrorTabOpen('src/moved.ts'), 'no mirror tab for the new name');
  assert.ok(!mirrorTabOpen('src/moveme.ts'), 'the old name\'s mirror tab is still open');
  console.log('[it] rename ok');

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

  // --- 12b. Mirror controls: the status row is on the playback mirror only,
  // pause and resume never flip playback back, and the setting hides the row.
  const aMirror = vscode.Uri.from({ scheme: 'agent-typewriter', path: '/src/a.ts' });
  const row = async (uri: vscode.Uri) =>
    ((await vscode.commands.executeCommand<vscode.CodeLens[]>('vscode.executeCodeLensProvider', uri)) ?? []).map(
      (l) => l.command?.title ?? '',
    );
  // Section 11 left the baseline budget at 0, which leaves src/a.ts without a baseline.
  await cfg().update('baselineBudgetMB', 256, WS);
  await settle();
  const atRow = timeline.all().length;
  write('src/a.ts', disk('src/a.ts') + '// row 1\n');
  await until('row change to play', () => timeline.all().length > atRow && idle() && player.playbackRelPath === 'src/a.ts', 20000);
  assert.equal(mirrorText('src/a.ts'), disk('src/a.ts'), 'mirror text changed by the row');
  await vscode.commands.executeCommand('agentTypewriter.pause');
  assert.equal(player.isPaused, true, 'pause did not pause');
  await vscode.commands.executeCommand('agentTypewriter.pause');
  assert.equal(player.isPaused, true, 'pause while paused resumed');
  write('src/a.ts', disk('src/a.ts') + '// row 2\n');
  await until('queued row change', () => timeline.pendingCount() === 1, 10000);
  const queuedSeq = timeline.all()[timeline.all().length - 1].seq;
  const titles = await row(aMirror);
  assert.ok(titles.includes('$(play) Play'), `row has no play: ${titles.join(' | ')}`);
  for (const button of ['$(zap) Finish', '$(arrow-right) Next', '$(debug-continue) Latest']) {
    assert.ok(titles.includes(button), `row has no ${button}: ${titles.join(' | ')}`);
  }
  assert.ok(titles.includes('1x'), `row has no speed: ${titles.join(' | ')}`);
  assert.ok(
    titles.some((t) => t.startsWith(`Paused before #${queuedSeq} src/a.ts · 1 queued · `)),
    `row readout wrong: ${titles.join(' | ')}`,
  );
  // The provider command needs the document loaded.
  const realA = await vscode.workspace.openTextDocument(vscode.Uri.file(path.join(root, 'src/a.ts')));
  assert.deepEqual(await row(realA.uri), [], 'row on the real file');
  // src/existing.ts was played in section 1, so its mirror exists.
  const otherMirror = await vscode.workspace.openTextDocument(vscode.Uri.from({ scheme: 'agent-typewriter', path: '/src/existing.ts' }));
  assert.deepEqual(await row(otherMirror.uri), [], 'row on another mirror');
  await vscode.commands.executeCommand('agentTypewriter.resume');
  assert.equal(player.isPaused, false, 'resume did not resume');
  await vscode.commands.executeCommand('agentTypewriter.resume');
  assert.equal(player.isPaused, false, 'resume while playing paused');
  await until('row change 2 to play', idle, 20000);
  const caughtUp = await row(aMirror);
  assert.ok(caughtUp.includes('$(debug-pause) Pause'), 'row did not switch to pause');
  // With the queued change played, the readout has moved past it to the end of the buffer.
  const n = timeline.all().length;
  assert.ok(caughtUp.includes(`Caught up · ${n} / ${n}`), `row readout after playing wrong: ${caughtUp.join(' | ')}`);
  assert.equal(mirrorText('src/a.ts'), disk('src/a.ts'), 'mirror text after the queued change differs from the after text');
  await cfg().update('mirrorStatusRow', false, WS);
  await settle();
  assert.deepEqual(await row(aMirror), [], 'row shown with mirrorStatusRow off');
  await cfg().update('mirrorStatusRow', undefined, WS);
  console.log('[it] mirror controls ok');

  // --- 13. Repository settings file: applies live, sits below workspace
  // settings, survives a broken save, and goes away with the file.
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
  // Linux can report a file in a just-created directory with only a change
  // event, which takes a baseline instead of recording a create. An edit after
  // either is recorded.
  await until('docs/guide.md seen', () => api.recorder.hasBaseline(uriOf('docs/guide.md')), 20000);
  write('docs/guide.md', '# Guide\n\nMore.\n');
  await until('docs/guide.md recorded', () => eventsFor('docs/guide.md', atProfile).some((e) => e.kind === 'modify'), 20000);
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
  const siblingDir = `${root}-sibling`;
  const label = path.basename(siblingDir);
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
}

/** PLAY and settings layering: playback and mirror documents, with changes pushed straight onto the timeline. */
async function playback(c: Context): Promise<void> {
  const { api, timeline, root, write, mirrorText, idle, player, scrubber, reorderWindow, cfg, WS, mirrorDoc } = c;

  // --- PLAY. Playback and mirror documents. Changes go straight onto the
  // timeline with the recorder stopped, so only the player sets the timing.
  {
    await until('idle before playback checks', idle);
    await vscode.commands.executeCommand('agentTypewriter.stop');
    const undo: Array<() => Thenable<void>> = [];
    const setting = async (section: string, key: string, value: unknown) => {
      const old = vscode.workspace.getConfiguration(section).inspect(key)?.workspaceValue;
      undo.push(() => vscode.workspace.getConfiguration(section).update(key, old, WS));
      await vscode.workspace.getConfiguration(section).update(key, value, WS);
    };
    const push = (relPath: string, before: string, after: string, kind?: 'create' | 'modify' | 'delete', eol: '\n' | '\r\n' = '\n') =>
      timeline.push({
        uri: vscode.Uri.file(path.join(root, relPath)).toString(),
        relPath,
        time: Date.now(),
        kind: kind ?? (before ? 'modify' : 'create'),
        before,
        after,
        eol,
        linesAdded: 0,
        linesRemoved: 0,
      });
    const playedNow = (seq: number) => () => timeline.stateOf(seq) === 'played' && idle();
    const play = async (relPath: string, before: string, after: string, kind?: 'create' | 'modify' | 'delete', eol?: '\n' | '\r\n') => {
      const e = push(relPath, before, after, kind, eol);
      await until(`${relPath} #${e.seq} playback`, playedNow(e.seq));
      return e;
    };
    const playing = (seq: number) => () => timeline.stateOf(seq) === 'playing';
    const isMirror = (d: vscode.TextDocument, rel: string) => d.uri.scheme === 'agent-typewriter' && d.uri.path === '/' + rel;
    const mirrorEditor = (rel: string) => vscode.window.visibleTextEditors.find((ed) => isMirror(ed.document, rel));
    /** Every text, and every content change, the mirror of `rel` goes through until disposed. */
    const record = (rel: string) => {
      const texts: string[] = [];
      const changes: vscode.TextDocumentContentChangeEvent[] = [];
      const sub = vscode.workspace.onDidChangeTextDocument((ev) => {
        if (!isMirror(ev.document, rel) || ev.contentChanges.length === 0) return;
        texts.push(ev.document.getText());
        changes.push(...ev.contentChanges);
      });
      return { texts, changes, dispose: () => sub.dispose() };
    };
    /** Set once the mirror of `rel` shows a non-empty selection: a long deletion's selection pause. */
    const selectionIn = (rel: string) => {
      const seen = { selected: false, dispose: () => sub.dispose() };
      const sub = vscode.window.onDidChangeTextEditorSelection((ev) => {
        if (isMirror(ev.textEditor.document, rel) && !ev.selections[0].isEmpty) seen.selected = true;
      });
      return seen;
    };

    // Mirrors are read-only, so VS Code keeps U+2028 in them and every later hunk lands where planned.
    await setting('editor', 'unusualLineTerminators', 'auto');
    const sep1 = 'const sep = "a\u2028b";\nlet x = 1;\n';
    const sep2 = sep1.replace('x = 1', 'x = 2');
    await play('play/sep.ts', '', sep1);
    await sleep(300);
    assert.equal(mirrorText('play/sep.ts'), sep1, 'U+2028 was stripped from the mirror');
    await play('play/sep.ts', sep1, sep2);
    await sleep(300);
    assert.equal(mirrorText('play/sep.ts'), sep2, 'a change after a U+2028 did not replay exactly');

    // No save participants run on mirrors, and they never become dirty.
    await setting('files', 'insertFinalNewline', true);
    await setting('files', 'trimTrailingWhitespace', true);
    await play('play/nofinal.ts', '', 'export const x = 1;');
    await play('play/trail.ts', '', 'foo  \nbar\n');
    for (const [rel, text] of [['play/nofinal.ts', 'export const x = 1;'], ['play/trail.ts', 'foo  \nbar\n']]) {
      assert.equal(mirrorText(rel), text, `${rel}: a save participant changed the mirror`);
      assert.equal(mirrorDoc(rel)?.isDirty, false, `${rel}: mirror left dirty`);
    }
    const nofinal = record('play/nofinal.ts');
    await play('play/nofinal.ts', 'export const x = 1;', 'export const x = 2;');
    nofinal.dispose();
    // A line-ending switch shows up as a whole-document change to the same text; skip it.
    const typing = nofinal.changes.filter((c) => !(c.text === 'export const x = 1;' && c.rangeLength === c.text.length));
    assert.ok(typing.length > 0 && typing[0].rangeLength < 'export const x = 1;'.length, 'the next change began by replacing the whole mirror');
    assert.equal(mirrorText('play/nofinal.ts'), 'export const x = 2;');

    // Skip to Latest leaves a newest mirror it had to fix up clean: a new CRLF
    // file, and a file with no line breaks while files.eol is CRLF.
    await setting('files', 'eol', '\r\n');
    await vscode.commands.executeCommand('agentTypewriter.togglePause');
    push('play/snapcrlf.ts', '', 'export const a = 1;\nexport const b = 2;\n', 'create', '\r\n');
    await vscode.commands.executeCommand('agentTypewriter.catchUp');
    assert.equal(mirrorDoc('play/snapcrlf.ts')?.eol, vscode.EndOfLine.CRLF, 'snapped CRLF mirror is not CRLF');
    assert.equal(mirrorText('play/snapcrlf.ts'), 'export const a = 1;\r\nexport const b = 2;\r\n');
    assert.equal(mirrorDoc('play/snapcrlf.ts')?.isDirty, false, 'Skip to Latest left a new CRLF mirror dirty');
    push('play/snapone.ts', '', 'export const one = 1;');
    await vscode.commands.executeCommand('agentTypewriter.catchUp');
    assert.equal(mirrorDoc('play/snapone.ts')?.eol, vscode.EndOfLine.LF, 'snapped LF mirror took the CRLF default');
    assert.equal(mirrorDoc('play/snapone.ts')?.isDirty, false, 'Skip to Latest left a one-line mirror dirty');
    await vscode.commands.executeCommand('agentTypewriter.togglePause');

    // A change recorded while Skip to Latest runs is never overwritten by the older snapshot.
    await setting('agentTypewriter', 'fileSwitchDelayMs', 0);
    let race = (await play('play/race.ts', '', 'export const race = 0;\n')).after;
    for (const delay of [0, 20, 60]) {
      const run = vscode.commands.executeCommand('agentTypewriter.catchUp');
      await sleep(delay);
      const newer = push('play/race.ts', race, race + `export const after${delay} = ${delay};\n`);
      await run;
      await until('playback after Skip to Latest', idle);
      assert.equal(timeline.pendingCount(), 0);
      assert.equal(timeline.stateOf(newer.seq), 'played');
      assert.equal(mirrorText('play/race.ts'), newer.after, `Skip to Latest (+${delay} ms) left an older state in the mirror`);
      race = newer.after;
    }

    // A seek made while Skip to Latest waits for the change being typed wins over the snap.
    await setting('agentTypewriter', 'fileSwitchDelayMs', 1500);
    await play('play/snapseek1.ts', '', 'export const one = 1;\n');
    const sought = push('play/snapseek2.ts', '', 'export const two = 2;\n');
    await until('the file-switch pause', playing(sought.seq));
    const snapping = player.snapToLatest();
    timeline.seek(sought.seq);
    await snapping;
    assert.equal(timeline.cursor, sought.seq, 'Skip to Latest overrode a seek made while it waited');
    await until('replay after the seek', playedNow(sought.seq));
    assert.equal(mirrorText('play/snapseek2.ts'), 'export const two = 2;\n');
    await setting('agentTypewriter', 'fileSwitchDelayMs', 0);

    // Typing and backspacing keep surrogate pairs whole (one unit per tick at 3600 cpm).
    await setting('agentTypewriter', 'charsPerMinute', 3600);
    const emoji1 = '# Release\nok 👍🏻 done\na 𝐀 b\nline2\n';
    const emoji2 = '# Release\nShip it 🚀 now\nok 👍🏿 done\na b\nline2 x\n';
    const emoji = record('play/emoji.ts');
    await play('play/emoji.ts', '', emoji1);
    await play('play/emoji.ts', emoji1, emoji2);
    emoji.dispose();
    const lone = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
    const split = emoji.texts.find((t) => lone.test(t));
    assert.equal(split, undefined, `a mirror state split a surrogate pair: ${JSON.stringify(split)}`);
    assert.ok(emoji.changes.every((c) => c.rangeLength < 10), 'typing went wrong and the mirror was replaced at the end');
    assert.equal(mirrorText('play/emoji.ts'), emoji2);

    // Pause holds long and multi-line deletions, and delete events.
    await setting('agentTypewriter', 'charsPerMinute', 240000);
    const funcs = 'KEEP\nfunction one() {\n  return 1;\n}\nKEEP2\nfunction two() {\n  return 2;\n}\nKEEP3\nfunction three() {\n  return 3;\n}\n';
    const kept = 'KEEP\nKEEP2\nKEEP3\n';
    await play('play/funcs.ts', '', funcs);
    const holdsWhilePaused = async (label: string, seq: number) => {
      await until(`${label} to start`, playing(seq));
      await vscode.commands.executeCommand('agentTypewriter.togglePause');
      await sleep(100);
      const atPause = mirrorText('play/funcs.ts');
      await sleep(2000);
      assert.equal(mirrorText('play/funcs.ts'), atPause, `${label}: the mirror changed while paused`);
      assert.equal(timeline.stateOf(seq), 'playing', `${label}: finished while paused`);
      await vscode.commands.executeCommand('agentTypewriter.togglePause');
      await until(`${label} playback`, playedNow(seq));
    };
    await holdsWhilePaused('multi-line deletions', push('play/funcs.ts', funcs, kept).seq);
    assert.equal(mirrorText('play/funcs.ts'), kept);
    await holdsWhilePaused('file deletion', push('play/funcs.ts', kept, '', 'delete').seq);
    assert.equal(mirrorText('play/funcs.ts'), '');

    // A seek while paused edits nothing more: not mid-typing, not after a deletion's selection pause.
    await setting('agentTypewriter', 'charsPerMinute', 1200);
    const first = await play('play/pause.ts', '', 'first\n');
    const typed = 'first\nabcdefghijklmnopqrstuvwxyz\n';
    const long = push('play/pause.ts', first.after, typed);
    await until('a partial insert', () => (mirrorText('play/pause.ts') ?? '').startsWith('first\nab'));
    await vscode.commands.executeCommand('agentTypewriter.togglePause');
    await sleep(300);
    const atPause = mirrorText('play/pause.ts');
    await scrubber.receive({ type: 'seek', seq: first.seq });
    assert.equal(mirrorText('play/pause.ts'), atPause, 'the mirror changed after a seek while paused');
    assert.equal(player.isPaused, true, 'seek changed the pause state');
    await sleep(300);
    assert.equal(mirrorText('play/pause.ts'), atPause, 'the mirror changed after a seek while paused');
    await vscode.commands.executeCommand('agentTypewriter.togglePause');
    await until('replay after the seek', playedNow(long.seq));
    assert.equal(mirrorText('play/pause.ts'), typed);

    await setting('agentTypewriter', 'charsPerMinute', 240000);
    const lines = 'keep\nremove this line\nand this one\n';
    const made = await play('play/seekdel.ts', '', lines);
    const cutting = selectionIn('play/seekdel.ts');
    const cut = push('play/seekdel.ts', lines, 'keep\n');
    await until('deletion selected', () => cutting.selected);
    cutting.dispose();
    await vscode.commands.executeCommand('agentTypewriter.togglePause');
    await scrubber.receive({ type: 'seek', seq: made.seq });
    assert.equal(mirrorText('play/seekdel.ts'), lines, 'a seek during the selection pause still deleted the selection');
    await vscode.commands.executeCommand('agentTypewriter.togglePause');
    await until('replay after the seek', playedNow(cut.seq));
    assert.equal(mirrorText('play/seekdel.ts'), 'keep\n');

    // Hiding the mirror tab during a pause does not abandon the change.
    await setting('agentTypewriter', 'fileSwitchDelayMs', 1500);
    let hideA = (await play('play/hideA.ts', '', 'export const a = 1;\n')).after;
    await play('play/hideB.ts', '', 'line1\nline2\nline3\n');
    const nextA = async () => (hideA = (await play('play/hideA.ts', hideA, hideA + '// again\n')).after);
    /** Shows the hideA mirror in the column that shows hideB, which hides hideB's tab. */
    const hideB = async () => {
      const ed = mirrorEditor('play/hideB.ts');
      assert.ok(ed, 'hideB mirror is not visible');
      await vscode.window.showTextDocument(mirrorDoc('play/hideA.ts')!, { viewColumn: ed.viewColumn, preview: false, preserveFocus: true });
    };
    const closeB = async () => {
      const tab = vscode.window.tabGroups.all
        .flatMap((g) => g.tabs)
        .find((t) => t.input instanceof vscode.TabInputText && t.input.uri.scheme === 'agent-typewriter' && t.input.uri.path === '/play/hideB.ts');
      assert.ok(tab, 'hideB mirror tab not found');
      await vscode.window.tabGroups.close(tab);
    };
    const hiddenDuringSwitch = async (label: string, before: string, after: string, kind?: 'delete', hide = hideB) => {
      await nextA();
      const e = push('play/hideB.ts', before, after, kind);
      await until(`${label} to start`, playing(e.seq));
      await sleep(300);
      await hide();
      await until(`${label} playback`, playedNow(e.seq));
      assert.equal(mirrorText('play/hideB.ts'), after, `${label}: hiding the tab during the file-switch pause abandoned the change`);
    };
    await hiddenDuringSwitch('delete event', 'line1\nline2\nline3\n', '', 'delete');
    await setting('agentTypewriter', 'maxAnimatedChars', 20);
    const bigText = `export const big = "${'x'.repeat(40)}";\n`;
    await hiddenDuringSwitch('instant change', '', bigText);
    await hiddenDuringSwitch('closed tab', bigText, bigText + '// typed\n', undefined, closeB);
    assert.ok(mirrorEditor('play/hideB.ts'), 'the closed mirror tab was not shown again');
    await setting('agentTypewriter', 'fileSwitchDelayMs', 30);
    const multi = 'line1\nline2\nline3\nline4\n';
    await play('play/hideB.ts', bigText + '// typed\n', multi);
    const selecting = selectionIn('play/hideB.ts');
    const trimmed = push('play/hideB.ts', multi, 'line1\n');
    await until('multi-line deletion selected', () => selecting.selected);
    selecting.dispose();
    await hideB();
    await until('multi-line deletion playback', playedNow(trimmed.seq));
    assert.equal(mirrorText('play/hideB.ts'), 'line1\n', 'hiding the tab during the selection pause abandoned the deletion');

    // A mirror reverted mid-change (closed with its edits dropped, or File: Revert)
    // is put back before the next hunk, so no hunk lands at a stale offset.
    const r0 = 'const a = 1;\nconst b = 2;\nconst c = 3;\n';
    const r1 = 'const a = 10;\nconst b = 20;\nconst c = 30;\n';
    const r2 = 'const a = 100;\nconst b = 200;\nconst c = 300;\n';
    await play('play/revert.ts', '', r0);
    await setting('agentTypewriter', 'charsPerMinute', 480);
    const revertMidChange = async (before: string, after: string, marker: string, command: string) => {
      const seen = record('play/revert.ts');
      const e = push('play/revert.ts', before, after);
      await until(`${marker} typed`, () => (mirrorText('play/revert.ts') ?? '').startsWith(marker));
      const ed = mirrorEditor('play/revert.ts')!;
      await vscode.window.showTextDocument(ed.document, { viewColumn: ed.viewColumn, preserveFocus: false, preview: false });
      const at = seen.texts.length;
      await vscode.commands.executeCommand(command);
      await until(`playback after ${command}`, playedNow(e.seq));
      seen.dispose();
      for (const t of seen.texts) {
        for (const line of t.split('\n').filter((l) => /^const [bc]/.test(l))) {
          assert.match(line, /^const [bc] = \d*;$/, `${command}: a hunk landed at a stale offset: ${JSON.stringify(t)}`);
        }
      }
      for (const t of seen.texts.slice(at)) {
        assert.ok(t === before || t.startsWith(marker), `${command}: typing went on from the reverted text: ${JSON.stringify(t)}`);
      }
      assert.equal(mirrorText('play/revert.ts'), after);
    };
    await revertMidChange(r0, r1, 'const a = 10;', 'workbench.action.revertAndCloseActiveEditor');
    await revertMidChange(r1, r2, 'const a = 100;', 'workbench.action.files.revert');

    // The next edit in the same file is scrolled to, not jumped to. Pause holds
    // the scroll; finish current and skip to latest end it; smoothScroll off jumps.
    await setting('agentTypewriter', 'charsPerMinute', 240000);
    await setting('agentTypewriter', 'maxAnimatedChars', 6000);
    await setting('agentTypewriter', 'readPauseSeconds', 0);
    await setting('agentTypewriter', 'scrollLinesPerSecond', 60);
    const tallLines = Array.from({ length: 400 }, (_, i) => `const line${i} = ${i};`);
    /** The mirror's current text with `edits` applied, so each step's change holds only its own hunks. */
    const tall = (edits: Record<number, string>) => (tallText ?? tallLines.join('\n') + '\n').split('\n').map((l, i) => edits[i] ?? l).join('\n');
    /** Top lines the mirror of `rel` shows, in order, until disposed. */
    const tops = (rel: string) => {
      const seen: number[] = [];
      const sub = vscode.window.onDidChangeTextEditorVisibleRanges((ev) => {
        if (isMirror(ev.textEditor.document, rel) && ev.visibleRanges.length > 0) seen.push(ev.visibleRanges[0].start.line);
      });
      return { seen, dispose: () => sub.dispose() };
    };
    const inView = (rel: string, line: number) =>
      mirrorEditor(rel)!.visibleRanges.some((r) => r.start.line <= line && line <= r.end.line);
    const toTop = async (rel: string) => {
      const ed = mirrorEditor(rel)!;
      ed.revealRange(new vscode.Range(0, 0, 0, 0), vscode.TextEditorRevealType.AtTop);
      await until(`${rel} scrolled to the top`, () => ed.visibleRanges[0]?.start.line === 0);
    };
    let tallText: string | undefined;
    tallText = (await play('play/scroll.ts', '', tall({}))).after;
    const scrollStep = async (label: string, edits: Record<number, string>, line: number) => {
      await toTop('play/scroll.ts');
      const seen = tops('play/scroll.ts');
      const e = push('play/scroll.ts', tallText!, tall(edits));
      return {
        e,
        seen,
        /** Waits for playback and the scroll to `line`; returns when playback ended. */
        done: async () => {
          await until(`${label} playback`, playedNow(e.seq));
          const playedAt = Date.now();
          assert.equal(mirrorText('play/scroll.ts'), e.after, `${label}: the mirror does not hold the after text`);
          // visibleRanges updates only once the renderer reports the scroll, which can trail a quick finish.
          await until(`${label}: line ${line} in view`, () => inView('play/scroll.ts', line), 2000);
          seen.dispose();
          tallText = e.after;
          return playedAt;
        },
      };
    };

    const smooth = await scrollStep('smooth scroll', { 3: 'const line3 = 30;', 350: 'const line350 = 3500;' }, 350);
    await smooth.done();
    const distinct = [...new Set(smooth.seen.seen)];
    assert.ok(distinct.length >= 5, `expected a scroll through several positions, saw tops ${distinct.join(',')}`);
    assert.ok(distinct.every((t, i) => i === 0 || t >= distinct[i - 1]), `the scroll went back up: ${distinct.join(',')}`);

    const paused = await scrollStep('paused scroll', { 360: 'const line360 = 3600;' }, 360);
    await until('the scroll to start', () => paused.seen.seen.some((t) => t > 0));
    await vscode.commands.executeCommand('agentTypewriter.togglePause');
    await sleep(300);
    const heldAt = paused.seen.seen.length;
    await sleep(600);
    assert.equal(paused.seen.seen.length, heldAt, 'the view kept scrolling while paused');
    assert.equal(timeline.stateOf(paused.e.seq), 'playing', 'the change finished while paused');
    await vscode.commands.executeCommand('agentTypewriter.togglePause');
    await paused.done();

    const finished = await scrollStep('finish mid-scroll', { 370: 'const line370 = 3700;' }, 370);
    await until('the scroll to start', () => finished.seen.seen.some((t) => t > 0));
    await vscode.commands.executeCommand('agentTypewriter.finishCurrent');
    await finished.done();

    const snapped = await scrollStep('skip to latest mid-scroll', { 380: 'const line380 = 3800;' }, 0);
    await until('the scroll to start', () => snapped.seen.seen.some((t) => t > 0));
    await vscode.commands.executeCommand('agentTypewriter.catchUp');
    assert.equal(mirrorText('play/scroll.ts'), snapped.e.after, 'skip to latest mid-scroll did not snap the mirror');
    const afterSnap = snapped.seen.seen.length;
    await sleep(300);
    assert.equal(snapped.seen.seen.length, afterSnap, 'the view kept scrolling after skip to latest');
    snapped.seen.dispose();
    tallText = snapped.e.after;

    await setting('agentTypewriter', 'smoothScroll', false);
    const jumped = await scrollStep('jump with smoothScroll off', { 390: 'const line390 = 3900;' }, 390);
    await jumped.done();
    assert.ok(new Set(jumped.seen.seen).size <= 2, `smoothScroll off still scrolled: ${jumped.seen.seen.join(',')}`);
    console.log('[it] smooth scroll to the next edit ok');

    // The read pause: before the view leaves what was just typed (an off-screen
    // edit or another file) it waits, counting time already passed. smoothScroll
    // off still waits; finish current ends it; a seek skips it.
    await setting('agentTypewriter', 'smoothScroll', true);
    await setting('agentTypewriter', 'readPauseSeconds', 1);
    /** When the mirror of `rel` changed, in order, until disposed. */
    const editTimes = (rel: string) => {
      const at: number[] = [];
      const sub = vscode.workspace.onDidChangeTextDocument((ev) => {
        if (isMirror(ev.document, rel) && ev.contentChanges.length > 0) at.push(Date.now());
      });
      return { at, dispose: () => sub.dispose() };
    };
    /** Plays a scrollStep and measures the ms from the last edit before the view first moved down to that move. */
    const scrollWait = async (label: string, edits: Record<number, string>, line: number) => {
      const changed = editTimes('play/scroll.ts');
      let movedAt: number | undefined;
      const sub = vscode.window.onDidChangeTextEditorVisibleRanges((ev) => {
        if (movedAt === undefined && isMirror(ev.textEditor.document, 'play/scroll.ts') && (ev.visibleRanges[0]?.start.line ?? 0) > 0) movedAt = Date.now();
      });
      const step = await scrollStep(label, edits, line);
      await step.done();
      sub.dispose();
      changed.dispose();
      assert.ok(movedAt !== undefined, `${label}: the view never moved`);
      const before = changed.at.filter((t) => t <= movedAt!);
      assert.ok(before.length > 0, `${label}: the view moved before anything was typed`);
      return { wait: movedAt - before[before.length - 1], tops: step.seen.seen };
    };

    const offScreen = await scrollWait('read pause before a scroll', { 4: 'const line4 = 40;', 345: 'const line345 = 3450;' }, 345);
    assert.ok(offScreen.wait >= 850 && offScreen.wait < 2500, `the view left line 4 after ${offScreen.wait} ms, not about 1 s`);

    await setting('agentTypewriter', 'smoothScroll', false);
    const offScreenJump = await scrollWait('read pause before a jump', { 7: 'const line7 = 70;', 347: 'const line347 = 3470;' }, 347);
    assert.ok(offScreenJump.wait >= 850 && offScreenJump.wait < 2500, `with smoothScroll off the view left line 7 after ${offScreenJump.wait} ms, not about 1 s`);
    assert.ok(new Set(offScreenJump.tops).size <= 2, `smoothScroll off still scrolled: ${offScreenJump.tops.join(',')}`);
    await setting('agentTypewriter', 'smoothScroll', true);

    await setting('agentTypewriter', 'readPauseSeconds', 3);
    const cutPause = await scrollStep('finish during the read pause', { 8: 'const line8 = 80;', 349: 'const line349 = 3490;' }, 349);
    await until('the first hunk of the cut change', () => mirrorText('play/scroll.ts').includes('const line8 = 80;'));
    const finishAt = Date.now();
    await vscode.commands.executeCommand('agentTypewriter.finishCurrent');
    const cutAt = await cutPause.done();
    assert.ok(cutAt - finishAt < 1500, `finish current took ${cutAt - finishAt} ms to end a 3 s read pause`);
    await setting('agentTypewriter', 'readPauseSeconds', 1);

    // Switching files: the last file stays in view for the read pause first.
    const a1 = await play('play/read-a.ts', '', 'export const a = 1;\n');
    const aEdits = editTimes('play/read-a.ts');
    let bShownAt: number | undefined;
    const bShown = vscode.window.onDidChangeVisibleTextEditors((eds) => {
      if (bShownAt === undefined && eds.some((ed) => isMirror(ed.document, 'play/read-b.ts'))) bShownAt = Date.now();
    });
    const a2 = push('play/read-a.ts', a1.after, 'export const a = 2;\n');
    const b1 = push('play/read-b.ts', '', 'export const b = 1;\n');
    await until('read-b playback', playedNow(b1.seq));
    aEdits.dispose();
    bShown.dispose();
    assert.equal(timeline.stateOf(a2.seq), 'played');
    assert.ok(bShownAt !== undefined && aEdits.at.length > 0, 'read-b was never shown after read-a was typed');
    const switchWait = bShownAt - aEdits.at[aEdits.at.length - 1];
    assert.ok(switchWait >= 850 && switchWait < 2500, `read-b was shown ${switchWait} ms after read-a's last edit, not about 1 s`);

    // A change that arrives after the read pause has passed switches with no added wait.
    await sleep(1500);
    const lateEdits = editTimes('play/read-a.ts');
    const pushedAt = Date.now();
    const a3 = push('play/read-a.ts', a2.after, 'export const a = 3;\n');
    await until('late read-a playback', playedNow(a3.seq));
    lateEdits.dispose();
    assert.ok(lateEdits.at.length > 0 && lateEdits.at[0] - pushedAt < 1100, `a late change waited ${lateEdits.at[0] - pushedAt} ms, though the read pause had passed`);
    assert.equal(mirrorText('play/read-a.ts'), a3.after);

    // A seek right after typing shows the other file with no read pause.
    const seekEdits = editTimes('play/read-b.ts');
    const seekAt = Date.now();
    await vscode.commands.executeCommand('agentTypewriter.seek', b1.seq);
    await until('read-b replayed after the seek', () => seekEdits.at.length > 0);
    seekEdits.dispose();
    assert.ok(seekEdits.at[0] - seekAt < 900, `after a seek read-b waited ${seekEdits.at[0] - seekAt} ms`);
    await until('idle after the seek', idle);
    assert.equal(mirrorText('play/read-b.ts'), b1.after);
    assert.equal(mirrorText('play/read-a.ts'), a3.after);

    // Pausing during the read pause keeps the old file in view until resumed.
    const bVisible = () => vscode.window.visibleTextEditors.some((ed) => isMirror(ed.document, 'play/read-b.ts'));
    const p1 = push('play/read-a.ts', a3.after, 'export const a = 4;\n');
    const p2 = push('play/read-b.ts', b1.after, 'export const b = 2;\n');
    await until('read-a typed before the pause', () => timeline.stateOf(p1.seq) === 'played');
    await vscode.commands.executeCommand('agentTypewriter.togglePause');
    await sleep(1500);
    assert.ok(!bVisible(), 'read-b was shown while playback was paused');
    assert.notEqual(timeline.stateOf(p2.seq), 'played', 'read-b played while paused');
    await vscode.commands.executeCommand('agentTypewriter.togglePause');
    await until('read-b after resuming', playedNow(p2.seq));
    assert.equal(mirrorText('play/read-b.ts'), p2.after);

    // A faster speed chosen during the read pause shortens what is left of it.
    await setting('agentTypewriter', 'readPauseSeconds', 6);
    const s1 = push('play/read-b.ts', p2.after, 'export const b = 3;\n');
    const s2 = push('play/read-a.ts', p1.after, 'export const a = 5;\n');
    await until('read-b typed before the speed change', () => timeline.stateOf(s1.seq) === 'played');
    const fasterAt = Date.now();
    await vscode.commands.executeCommand('agentTypewriter.setSpeed', 6);
    await until('read-a after the speed change', playedNow(s2.seq));
    const fasterWait = Date.now() - fasterAt;
    await vscode.commands.executeCommand('agentTypewriter.setSpeed', 1);
    assert.ok(fasterWait < 3000, `a 6 s read pause at 6x took ${fasterWait} ms more after the speed change`);
    assert.equal(mirrorText('play/read-a.ts'), s2.after);

    // A rename that also edits far down jumps to that edit on the new name, with no read pause there.
    await setting('agentTypewriter', 'readPauseSeconds', 3);
    const moveText = tallLines.join('\n') + '\n';
    await play('play/read-move.ts', '', moveText);
    const movedTops = tops('play/read-moved.ts');
    const movedEdits = editTimes('play/read-moved.ts');
    let movedShownAt: number | undefined;
    const movedShown = vscode.window.onDidChangeVisibleTextEditors((eds) => {
      if (movedShownAt === undefined && eds.some((ed) => isMirror(ed.document, 'play/read-moved.ts'))) movedShownAt = Date.now();
    });
    const moved = timeline.push({
      uri: vscode.Uri.file(path.join(root, 'play/read-moved.ts')).toString(),
      relPath: 'play/read-moved.ts',
      fromUri: vscode.Uri.file(path.join(root, 'play/read-move.ts')).toString(),
      fromRelPath: 'play/read-move.ts',
      time: Date.now(),
      kind: 'rename',
      before: moveText,
      after: tallLines.map((l, i) => (i === 300 ? 'const line300 = 3000;' : l)).join('\n') + '\n',
      eol: '\n',
      linesAdded: 1,
      linesRemoved: 1,
    });
    await until('rename with an edit playback', playedNow(moved.seq));
    movedTops.dispose();
    movedEdits.dispose();
    movedShown.dispose();
    assert.equal(mirrorText('play/read-moved.ts'), moved.after);
    assert.ok(new Set(movedTops.seen).size <= 2, `the first edit after a rename was scrolled to: ${movedTops.seen.join(',')}`);
    const firstMovedEdit = movedEdits.at.find((t) => t >= (movedShownAt ?? 0));
    assert.ok(movedShownAt !== undefined && firstMovedEdit !== undefined, 'the renamed mirror was never shown and edited');
    assert.ok(firstMovedEdit - movedShownAt < 1500, `the first edit after a rename waited ${firstMovedEdit - movedShownAt} ms on the new name`);
    await setting('agentTypewriter', 'readPauseSeconds', 0);
    console.log('[it] read pause ok');

    // A nearby edit in view is reached with arrow keys, a line at a time.
    // Pause holds the walk; arrowNavigation off puts the caret there at once.
    await setting('agentTypewriter', 'arrowNavigation', true);
    await setting('agentTypewriter', 'arrowKeysPerSecond', 15);
    const shortLines = Array.from({ length: 24 }, (_, i) => `let v${i} = ${i};`);
    /** The mirror's current text with `edits` applied, so each step's change holds only its own hunks. */
    const short = (edits: Record<number, string>) => (shortText ?? shortLines.join('\n') + '\n').split('\n').map((l, i) => edits[i] ?? l).join('\n');
    let shortText: string | undefined;
    shortText = (await play('play/arrows.ts', '', short({}))).after;
    /** Caret lines the mirror of `rel` shows, in order, until disposed. */
    const caretLines = (rel: string) => {
      const seen: number[] = [];
      const sub = vscode.window.onDidChangeTextEditorSelection((ev) => {
        if (isMirror(ev.textEditor.document, rel)) seen.push(ev.selections[0].active.line);
      });
      return { seen, dispose: () => sub.dispose() };
    };
    const arrowStep = async (label: string, edits: Record<number, string>, lines: number[]) => {
      await toTop('play/arrows.ts');
      for (const line of lines) assert.ok(inView('play/arrows.ts', line), `${label}: line ${line} is not in view; the window is too small`);
      const seen = caretLines('play/arrows.ts');
      const e = push('play/arrows.ts', shortText!, short(edits));
      return {
        e,
        seen,
        done: async () => {
          await until(`${label} playback`, playedNow(e.seq));
          seen.dispose();
          assert.equal(mirrorText('play/arrows.ts'), e.after, `${label}: the mirror does not hold the after text`);
          shortText = e.after;
        },
      };
    };
    const visited = (seen: number[], from: number, to: number) => Array.from({ length: to - from - 1 }, (_, i) => from + 1 + i).filter((l) => !seen.includes(l));

    const walked = await arrowStep('arrow walk', { 1: 'let v1 = 10;', 9: 'let v9 = 90;' }, [1, 9]);
    await walked.done();
    assert.deepEqual(visited(walked.seen.seen, 1, 9), [], `the caret skipped lines between edits: ${walked.seen.seen.join(',')}`);

    // Slow keys, so the pause lands mid-walk even on a slow runner.
    await setting('agentTypewriter', 'arrowKeysPerSecond', 5);
    const held = await arrowStep('paused arrow walk', { 16: 'let v16 = 160;' }, [9, 16]);
    await until('the arrow walk to start', () => held.seen.seen.some((l) => l > 9 && l < 16));
    await vscode.commands.executeCommand('agentTypewriter.togglePause');
    await sleep(300);
    const heldAtKeys = held.seen.seen.length;
    await sleep(600);
    assert.equal(held.seen.seen.length, heldAtKeys, 'the caret kept moving while paused');
    assert.equal(timeline.stateOf(held.e.seq), 'playing', 'the change finished while paused');
    await vscode.commands.executeCommand('agentTypewriter.togglePause');
    await held.done();

    const finishedWalk = await arrowStep('finish mid-walk', { 8: 'let v8 = 80;' }, [8, 16]);
    await until('the arrow walk to start', () => finishedWalk.seen.seen.some((l) => l > 8 && l < 16));
    await vscode.commands.executeCommand('agentTypewriter.finishCurrent');
    await finishedWalk.done();
    assert.equal(mirrorEditor('play/arrows.ts')!.selection.active.line, 8, 'finish current mid-walk left the caret away from the edit');

    const snappedWalk = await arrowStep('skip to latest mid-walk', { 16: 'let v16 = 1600;' }, [8, 16]);
    await until('the arrow walk to start', () => snappedWalk.seen.seen.some((l) => l > 8 && l < 16));
    await vscode.commands.executeCommand('agentTypewriter.catchUp');
    assert.equal(mirrorText('play/arrows.ts'), snappedWalk.e.after, 'skip to latest mid-walk did not snap the mirror');
    const afterWalkSnap = snappedWalk.seen.seen.length;
    await sleep(500);
    assert.equal(snappedWalk.seen.seen.length, afterWalkSnap, 'the caret kept walking after skip to latest');
    snappedWalk.seen.dispose();
    shortText = snappedWalk.e.after;

    await setting('agentTypewriter', 'arrowNavigation', false);
    const clicked = await arrowStep('arrowNavigation off', { 22: 'let v22 = 220;' }, [16, 22]);
    await clicked.done();
    assert.deepEqual(visited(clicked.seen.seen, 16, 22), [17, 18, 19, 20, 21], `arrowNavigation off still walked: ${clicked.seen.seen.join(',')}`);
    console.log('[it] arrow keys to nearby edits ok');

    // A rename shows the old name, moves the mirror, then types the edit (at-kbn.2).
    await setting('agentTypewriter', 'charsPerMinute', 3600);
    const mirrorTabs = (rel: string) =>
      vscode.window.tabGroups.all.flatMap((g) => g.tabs).filter((t) => t.input instanceof vscode.TabInputText && isMirror({ uri: t.input.uri } as vscode.TextDocument, rel));
    const mirrorGone = async (rel: string) => {
      try {
        await vscode.workspace.fs.stat(vscode.Uri.from({ scheme: 'agent-typewriter', path: '/' + rel }));
        return false;
      } catch {
        return true;
      }
    };
    const moved0 = 'const a = 1;\nconst b = 2;\n';
    const moved1 = moved0 + 'const c = 3;\n';
    const pushRename = (from: string, to: string, before: string, after: string) =>
      timeline.push({
        uri: vscode.Uri.file(path.join(root, to)).toString(),
        relPath: to,
        fromUri: vscode.Uri.file(path.join(root, from)).toString(),
        fromRelPath: from,
        time: Date.now(),
        kind: 'rename',
        before,
        after,
        eol: '\n',
        linesAdded: 1,
        linesRemoved: 0,
      });
    await play('play/old-name.ts', '', moved0);
    const typedAfterMove = record('play/new-name.ts');
    const ren = pushRename('play/old-name.ts', 'play/new-name.ts', moved0, moved1);
    await until('rename playback', playedNow(ren.seq));
    typedAfterMove.dispose();
    assert.equal(mirrorText('play/new-name.ts'), moved1);
    assert.equal(mirrorTabs('play/old-name.ts').length, 0, 'the old name still has a tab');
    assert.equal(mirrorTabs('play/new-name.ts').length, 1, 'the new name has no tab');
    assert.ok(await mirrorGone('play/old-name.ts'), 'the old mirror document is still there');
    assert.ok(typedAfterMove.changes.length > 0 && typedAfterMove.texts.every((t) => t.startsWith(moved0)), 'the edit was not typed onto the moved text');

    // Skip to latest past a queued rename leaves no old mirror either.
    await play('play/snap-old.ts', '', moved0);
    await vscode.commands.executeCommand('agentTypewriter.pause');
    const snapRen = pushRename('play/snap-old.ts', 'play/snap-new.ts', moved0, moved1);
    await vscode.commands.executeCommand('agentTypewriter.catchUp');
    assert.equal(timeline.stateOf(snapRen.seq), 'played');
    assert.ok(await mirrorGone('play/snap-old.ts'), 'skip to latest left the old mirror');
    assert.equal(mirrorTabs('play/snap-old.ts').length, 0, 'skip to latest left the old tab');
    assert.equal(new TextDecoder().decode(await vscode.workspace.fs.readFile(vscode.Uri.from({ scheme: 'agent-typewriter', path: '/play/snap-new.ts' }))), moved1);
    await vscode.commands.executeCommand('agentTypewriter.resume');

    // Highlights: marks against the baseline as a net diff, growing while typing,
    // cleared per file and for all, brought back by replaying from before a clear.
    await setting('agentTypewriter', 'charsPerMinute', 240000);
    const hlUri = (rel: string) => vscode.Uri.from({ scheme: 'agent-typewriter', path: '/' + rel });
    const drawn = (rel: string) => api.highlights.drawn.get(hlUri(rel).toString());
    const drawnIs = (rel: string, want: unknown) => () => JSON.stringify(drawn(rel) ?? null) === JSON.stringify(want);
    const hl0 = 'one\nlet two = 2;\nthree\nfour\n';
    const hl1 = 'one\nlet TWO = 2;\nthree\nfour\nfive\n';
    const hl2 = 'one\nlet TWO = 2;\nfour\nfive\n';
    const firstHl = await play('play/hl-a.ts', hl0, hl1);
    assert.equal(mirrorText('play/hl-a.ts'), hl1, 'highlighting changed the mirror text');
    await until('word change and new line highlighted', drawnIs('play/hl-a.ts', {
      lines: [1, 4],
      chars: [{ line: 1, start: 4, end: 7 }],
      removals: [{ line: 1, texts: ['two'] }],
    }), 5000);
    await play('play/hl-a.ts', hl1, hl2);
    await until('removed line marked', drawnIs('play/hl-a.ts', {
      lines: [1, 3],
      chars: [{ line: 1, start: 4, end: 7 }],
      removals: [{ line: 1, texts: ['two'] }, { line: 2, texts: ['three\n'] }],
    }), 5000);
    assert.equal(mirrorText('play/hl-a.ts'), hl2);
    // Added and then removed again: nothing to show.
    await play('play/hl-c.ts', 'p\n', 'p\nq\n');
    await until('hl-c highlighted', drawnIs('play/hl-c.ts', { lines: [1], chars: [], removals: [] }), 5000);
    await play('play/hl-c.ts', 'p\nq\n', 'p\n');
    await until('added then removed leaves no mark', drawnIs('play/hl-c.ts', null), 5000);
    assert.ok(api.highlights.hasHighlights, 'hl-a has highlights but none are reported');
    // Typed text is highlighted before the change finishes.
    await setting('agentTypewriter', 'charsPerMinute', 600);
    const slow = push('play/hl-e.ts', 'a\n', 'a\nhello there, typed slowly\n');
    await until('typed text highlighted mid-change', () => timeline.stateOf(slow.seq) === 'playing' && (drawn('play/hl-e.ts')?.lines ?? []).includes(1), 15000);
    await vscode.commands.executeCommand('agentTypewriter.finishCurrent');
    await until('slow change played', playedNow(slow.seq));
    await setting('agentTypewriter', 'charsPerMinute', 240000);
    await until('finished change stays highlighted', drawnIs('play/hl-e.ts', { lines: [1], chars: [], removals: [] }), 5000);
    // Clear one file: it starts over from its current text; other files keep theirs.
    await vscode.commands.executeCommand('agentTypewriter.clearHighlightsInFile', hlUri('play/hl-e.ts'));
    await until('hl-e cleared', drawnIs('play/hl-e.ts', null), 5000);
    assert.ok(api.highlights.hasHighlights, 'clearing hl-e cleared hl-a too');
    await play('play/hl-a.ts', hl2, hl2 + 'six\n');
    await until('hl-a still highlighted against its old baseline', drawnIs('play/hl-a.ts', {
      lines: [1, 3, 4],
      chars: [{ line: 1, start: 4, end: 7 }],
      removals: [{ line: 1, texts: ['two'] }, { line: 2, texts: ['three\n'] }],
    }), 5000);
    await vscode.commands.executeCommand('agentTypewriter.clearHighlightsInFile', hlUri('play/hl-a.ts'));
    await until('hl-a cleared', drawnIs('play/hl-a.ts', null), 5000);
    await play('play/hl-a.ts', hl2 + 'six\n', hl2 + 'six\nseven\n');
    await until('later change highlighted against the new baseline', drawnIs('play/hl-a.ts', { lines: [5], chars: [], removals: [] }), 5000);
    // Clear all, then replay from before the clear: the highlights come back.
    await vscode.commands.executeCommand('agentTypewriter.clearHighlights');
    await until('all cleared', () => drawn('play/hl-a.ts') === undefined && !api.highlights.hasHighlights, 5000);
    // A line break added at the end draws nothing, so the clear buttons stay off.
    await play('play/hl-k.ts', 'ab', 'ab\n');
    await sleep(400);
    assert.equal(drawn('play/hl-k.ts'), undefined, 'a final line break was drawn');
    assert.ok(!api.highlights.hasHighlights, 'clear buttons on with nothing drawn');
    // Typing into a cleared buffer: the clear buttons see the highlights before the change finishes.
    await setting('agentTypewriter', 'charsPerMinute', 600);
    const lagged = push('play/hl-h.ts', 'a\n', 'a\nthe clear button sees this before it is done\n');
    await until('highlights reported mid-change', () => timeline.stateOf(lagged.seq) === 'playing' && api.highlights.hasHighlights, 15000);
    // The title bar button's context key names the mirror being typed into.
    assert.ok(api.highlights.highlightedPaths.includes('/play/hl-h.ts'), `context key lacks the typing mirror: ${api.highlights.highlightedPaths.join(', ')}`);
    // Skipping it: its half-typed text stops counting as live at once, before the player lets go.
    assert.ok(api.player.liveText('play/hl-h.ts') !== undefined, 'no live text while typing');
    timeline.seek(lagged.seq + 1);
    const stopping = api.player.interrupt();
    assert.equal(api.player.liveText('play/hl-h.ts'), undefined, 'an interrupted change still reports live text');
    await stopping;
    await setting('agentTypewriter', 'charsPerMinute', 240000);
    await vscode.commands.executeCommand('agentTypewriter.seek', firstHl.seq);
    await until('replay after clear', idle, 20000);
    await vscode.commands.executeCommand('vscode.open', hlUri('play/hl-a.ts'), { preview: false });
    await until('replay brings the cleared highlights back', drawnIs('play/hl-a.ts', {
      lines: [1, 3, 4, 5],
      chars: [{ line: 1, start: 4, end: 7 }],
      removals: [{ line: 1, texts: ['two'] }, { line: 2, texts: ['three\n'] }],
    }), 5000);
    // Text about to be deleted is previewed before it goes, and not with markDeletions off.
    await setting('agentTypewriter', 'charsPerMinute', 600);
    const delText = 'first\nsecond\nthird\n';
    const previews = (want: string) => {
      const seen = { hit: false, stop: () => clearInterval(timer) };
      const timer = setInterval(() => {
        if (api.player.deletionPreview === want) seen.hit = true;
      }, 10);
      return seen;
    };
    const longDel = previews('second\nthird\n');
    await play('play/hl-g.ts', delText, 'first\n');
    longDel.stop();
    assert.ok(longDel.hit, 'a multi-line deletion was not previewed');
    // "total" -> "t" backspaces the word, then types the "t".
    const shortDel = previews('total');
    await play('play/hl-g.ts', 'first\n', 'first\nlet total = 1;\n');
    await play('play/hl-g.ts', 'first\nlet total = 1;\n', 'first\nlet t = 1;\n');
    shortDel.stop();
    assert.ok(shortDel.hit, 'a backspaced word was not previewed');
    assert.equal(api.player.deletionPreview, undefined, 'the preview stayed up after the deletion');
    await setting('agentTypewriter', 'markDeletions', false);
    const offDel = previews('first\nlet t = 1;\n');
    await play('play/hl-g.ts', 'first\nlet t = 1;\n', '');
    offDel.stop();
    assert.ok(!offDel.hit, 'a deletion was previewed with markDeletions off');
    await setting('agentTypewriter', 'markDeletions', true);
    await setting('agentTypewriter', 'charsPerMinute', 240000);

    // A seek takes marks that no longer fit down at once, not after the redraw throttle.
    await play('play/hl-j.ts', 'a\n', 'a\nb\n');
    await until('hl-j highlighted', drawnIs('play/hl-j.ts', { lines: [1], chars: [], removals: [] }), 5000);
    await vscode.commands.executeCommand('agentTypewriter.pause');
    const hlj = timeline.all().filter((e) => e.relPath === 'play/hl-j.ts').pop()!;
    api.highlights.refresh();
    await sleep(30);
    // A redraw just ran, so the throttle holds the next one back; only the jump check can clear in time.
    timeline.seek(hlj.seq);
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));
    assert.equal(drawn('play/hl-j.ts'), undefined, 'stale marks stayed up after a seek');
    await vscode.commands.executeCommand('agentTypewriter.resume');
    await until('hl-j replayed', idle, 10000);
    // Hovering a line with a removal marker shows the removed text; other lines show none.
    const hoverText = async (rel: string, line: number) => {
      const hovers = await vscode.commands.executeCommand<vscode.Hover[]>('vscode.executeHoverProvider', hlUri(rel), new vscode.Position(line, 1));
      return hovers.flatMap((h) => h.contents.map((c) => (typeof c === 'string' ? c : c.value))).join('\n');
    };
    // hl-a is no longer the tab in front; hovering works on its document all the same.
    assert.match(await hoverText('play/hl-a.ts', 2), /Removed[\s\S]*three/, 'no hover with the removed line');
    assert.doesNotMatch(await hoverText('play/hl-a.ts', 0), /Removed/, 'a hover on a line with nothing removed');
    // During a rename's move pause the old mirror keeps its highlights, and a clear there follows the file.
    await play('play/hl-r-old.ts', 'r0\n', 'r0\nr1\n');
    const renHl = pushRename('play/hl-r-old.ts', 'play/hl-r-new.ts', 'r0\nr1\n', 'r0\nr1\nr2\n');
    await until(
      'old mirror highlighted during the move',
      () => timeline.stateOf(renHl.seq) === 'playing' && api.player.playbackRelPath === 'play/hl-r-old.ts' && (drawn('play/hl-r-old.ts')?.lines ?? []).includes(1),
      5000,
    );
    await vscode.commands.executeCommand('agentTypewriter.clearHighlightsInFile', hlUri('play/hl-r-old.ts'));
    await until('rename with a clear played', playedNow(renHl.seq));
    await until('the clear followed the file to its new path', drawnIs('play/hl-r-new.ts', null), 5000);
    // A deleted file shows one removal marker at line 1, with its text on hover.
    await play('play/hl-d.ts', 'gone\nfile\n', '', 'delete');
    await until('deleted file marked', drawnIs('play/hl-d.ts', { lines: [], chars: [], removals: [{ line: 0, texts: ['gone\nfile\n'] }] }), 5000);
    assert.match(await hoverText('play/hl-d.ts', 0), /gone/, 'no hover on the deleted file');
    // Both settings off: nothing is drawn.
    await setting('agentTypewriter', 'markDeletions', false);
    await until('markDeletions off', drawnIs('play/hl-d.ts', null), 5000);
    await setting('agentTypewriter', 'highlightAdditions', false);
    await until('highlights off everywhere', () => !api.highlights.hasHighlights, 5000);
    await play('play/hl-f.ts', 'x\n', 'x\ny\n');
    await sleep(300);
    assert.equal(drawn('play/hl-f.ts'), undefined, 'drawn with both settings off');
    assert.equal(mirrorText('play/hl-f.ts'), 'x\ny\n');
    // Turned back on, the highlights of every played change since the baseline return.
    await setting('agentTypewriter', 'highlightAdditions', true);
    await setting('agentTypewriter', 'markDeletions', true);
    await until('highlights back after turning them on', drawnIs('play/hl-f.ts', { lines: [1], chars: [], removals: [] }), 5000);
    // With both settings off nothing is diffed. Turning one back on while a file
    // that is slow to diff is typed still brings up a later file's clear buttons.
    const bigPool = Array.from({ length: 8 }, (_, i) => `r,0,${i},0\n`);
    const big1 = Array.from({ length: 8000 }, (_, i) => bigPool[(i * 5 + (i >> 3)) % 8]).join('');
    const big2 = big1.split(/(?<=\n)/).map((l, i) => (i % 8 === 3 ? 'changed\n' : l)).join('');
    await play('play/hl-big.ts', '', big1);
    await vscode.commands.executeCommand('agentTypewriter.clearHighlightsInFile', hlUri('play/hl-big.ts'));
    await play('play/hl-big.ts', big1, big2);
    await setting('agentTypewriter', 'markDeletions', false);
    await setting('agentTypewriter', 'highlightAdditions', false);
    await play('play/hl-late.ts', 'g\nx\n', 'g\ny\n');
    await setting('agentTypewriter', 'charsPerMinute', 600);
    const slowBig = push('play/hl-big.ts', big2, big2 + 'typed slowly at the end of a file that is slow to diff\n');
    await until('big file typing', playing(slowBig.seq), 15000);
    await setting('agentTypewriter', 'markDeletions', true);
    await until('later file reported while the slow file is typed', () => api.highlights.highlightedPaths.includes('/play/hl-late.ts'), 4000);
    assert.equal(timeline.stateOf(slowBig.seq), 'playing', 'the slow change finished before the check');
    await vscode.commands.executeCommand('agentTypewriter.finishCurrent');
    await until('slow big change played', playedNow(slowBig.seq));
    await setting('agentTypewriter', 'highlightAdditions', true);
    // Each change of an uninterrupted run is its own live change: marks drawn during one are not kept into the next.
    const run1 = push('play/hl-t.ts', 'a\n', 'a\nthe first change of a run\n');
    const run2 = push('play/hl-t.ts', 'a\nthe first change of a run\n', 'a\nthe first change of a run\nand the second\n');
    await until('first change of the run typing', () => playing(run1.seq)() && api.player.liveToken('play/hl-t.ts') !== undefined, 15000);
    const firstToken = api.player.liveToken('play/hl-t.ts');
    await vscode.commands.executeCommand('agentTypewriter.finishCurrent');
    await until('second change of the run typing', () => playing(run2.seq)() && api.player.liveToken('play/hl-t.ts') !== undefined, 15000);
    assert.notEqual(api.player.liveToken('play/hl-t.ts'), firstToken, 'two changes of one run share a live token');
    await vscode.commands.executeCommand('agentTypewriter.finishCurrent');
    await until('run played', playedNow(run2.seq));
    await setting('agentTypewriter', 'charsPerMinute', 240000);
    // A real file open beside the mirrors is never decorated.
    await vscode.window.showTextDocument(vscode.Uri.file(path.join(root, 'src/existing.ts')), { viewColumn: vscode.ViewColumn.One, preview: false, preserveFocus: true });
    await sleep(300);
    assert.ok([...api.highlights.drawn.keys()].every((k) => k.startsWith('agent-typewriter:')), 'a real file got highlights');
    console.log('[it] highlights ok');

    for (const restore of undo.reverse()) await restore();
    await vscode.commands.executeCommand('agentTypewriter.start');
    console.log('[it] playback and mirrors ok');
  }

  // Settings layering: wrong-typed VS Code settings resolve as if unset,
  // object settings merge across user and workspace, and a repository file
  // replaced by a directory stops applying.
  {
    // This bundle's own copy of the config module: it reads VS Code settings
    // like the extension does, but has no repository file values.
    const { readSettings, workspaceOverrides } = await import('../src/config');
    const GLOBAL = vscode.ConfigurationTarget.Global;
    const recordedSince = (rel: string, from: number) => timeline.all().slice(from).some((e) => e.relPath === rel);

    // A profile's filters sit above the user setting and the file; turn it off so those show.
    const savedProfile = cfg().inspect('activeProfile')?.workspaceValue;
    await cfg().update('activeProfile', undefined, WS);

    // A non-numeric pace falls back to the default instead of hanging playback.
    await until('idle before SET', idle);
    const savedPace = (['charsPerMinute', 'catchUpFactor'] as const).map((k) => [k, cfg().inspect(k)?.workspaceValue] as const);
    await cfg().update('charsPerMinute', 'fast', WS);
    await cfg().update('catchUpFactor', 'auto', WS);
    assert.equal(readSettings().charsPerMinute, 350);
    assert.equal(readSettings().catchUpFactor, 0.5);
    const atPace = timeline.all().length;
    write('src/setPace.ts', 'export const pace = 1;\n');
    await until('setPace.ts recorded', () => recordedSince('src/setPace.ts', atPace), 20000);
    await until('setPace.ts playback at the default pace', idle, 20000);
    assert.equal(mirrorText('src/setPace.ts'), 'export const pace = 1;\n');
    for (const [k, v] of savedPace) await cfg().update(k, v, WS);

    // A string extensions setting counts as unset; recording and Stop/Start keep working.
    const savedExtensions = cfg().inspect('extensions')?.workspaceValue;
    await cfg().update('extensions', 'ts', WS);
    assert.deepEqual(readSettings().extensions, [], 'a string extensions setting came through');
    await cfg().update('extensions', ['md'], GLOBAL);
    assert.deepEqual(readSettings().extensions, ['md'], 'a valid user value lost to a wrong-typed workspace value');
    await cfg().update('extensions', undefined, GLOBAL);
    await sleep(500);
    const atTyped = timeline.all().length;
    write('src/setTyped.ts', 'export const typed = 1;\n');
    await until('write recorded with wrong-typed extensions', () => recordedSince('src/setTyped.ts', atTyped), 20000);
    await vscode.commands.executeCommand('agentTypewriter.stop');
    await vscode.commands.executeCommand('agentTypewriter.start');
    assert.ok(api.recorder.isRunning, 'Start failed with wrong-typed extensions');
    await sleep(1000);
    const atRestart = timeline.all().length;
    write('src/setTyped.ts', 'export const typed = 2;\n');
    await until('write recorded after Stop/Start', () => recordedSince('src/setTyped.ts', atRestart), 20000);
    await cfg().update('extensions', savedExtensions, WS);
    await until('wrong-typed extensions playback', idle);

    // A wrong-typed exclude keeps the contributed default list, and does not override the file.
    const savedExclude = cfg().inspect('exclude')?.workspaceValue;
    await cfg().update('exclude', '**/dist/**', WS);
    assert.deepEqual(readSettings().exclude, cfg().inspect('exclude')?.defaultValue);
    assert.deepEqual(workspaceOverrides(['exclude']), [], 'a wrong-typed workspace exclude reported as an override');
    await cfg().update('exclude', savedExclude, WS);

    // languageSpeeds merges user and workspace entries, as VS Code does.
    await cfg().update('languageSpeeds', { markdown: 80 }, GLOBAL);
    await cfg().update('languageSpeeds', { typescript: 20 }, WS);
    assert.deepEqual(readSettings().languageSpeeds, { markdown: 80, typescript: 20 });
    await cfg().update('languageSpeeds', undefined, WS);
    await cfg().update('languageSpeeds', undefined, GLOBAL);

    // A directory in place of the repository file drops the file's values.
    const settingsFile = path.join(root, '.agent-typewriter.json');
    const savedFile = fs.existsSync(settingsFile) ? fs.readFileSync(settingsFile, 'utf8') : undefined;
    const excluded = vscode.Uri.file(path.join(root, 'src/skip/a.ts'));
    fs.writeFileSync(settingsFile, JSON.stringify({ exclude: ['src/skip/**'] }));
    await until('repository file exclude to apply', () => !api.recorder.matches(excluded), 10000);
    fs.unlinkSync(settingsFile);
    fs.mkdirSync(settingsFile);
    await until('directory in place of the file to stop applying', () => api.recorder.matches(excluded), 10000);
    fs.rmdirSync(settingsFile);
    fs.writeFileSync(settingsFile, JSON.stringify({ exclude: ['src/skip/**'] }));
    await until('file written again to apply', () => !api.recorder.matches(excluded), 10000);
    if (savedFile === undefined) fs.unlinkSync(settingsFile);
    else fs.writeFileSync(settingsFile, savedFile);
    await cfg().update('activeProfile', savedProfile, WS);
    await until('restored filters', () => api.recorder.matches(excluded), 10000);

    // The settings writes above are recorded too, up to a reorder window later.
    for (let n = -1; n !== timeline.all().length; ) {
      n = timeline.all().length;
      await sleep(reorderWindow + 1500);
    }
    await until('SET playback', idle);
    console.log('[it] settings layering ok');
  }
}

/** ACT: commands and settings that change what is recorded, including the history settings restore.ts checks. */
async function reload(c: Context): Promise<void> {
  const {
    api,
    timeline,
    root,
    write,
    disk,
    mirrorText,
    idle,
    player,
    reorderWindow,
    cfg,
    WS,
    repoFile,
    settle,
    uriOf,
    eventsFor,
    folder,
    gitIn,
    own,
    choose,
    since,
  } = c;

  // ACT a. Watch Only This and Add to Watch on the workspace root write a
  // folder-relative glob, and a folder named like a route ("[id]") matches itself.
  const includeValue = () => cfg().inspect('include')?.workspaceValue;
  const atRoot = timeline.all().length;
  await vscode.commands.executeCommand('agentTypewriter.watchOnlyThis', folder.uri);
  assert.deepEqual(includeValue(), ['**/*'], 'Watch Only This on the root did not write a whole-folder glob');
  await sleep(500);
  write('src/actRoot.ts', 'export const actRoot = 1;\n');
  await until('write after Watch Only This on the root', () => eventsFor('src/actRoot.ts', atRoot).length === 1, 20000);
  await vscode.commands.executeCommand('agentTypewriter.addToWatch', folder.uri);
  assert.deepEqual(includeValue(), ['**/*'], 'Add to Watch on the root did not write a whole-folder glob');
  await sleep(500);
  write('src/actRoot.ts', 'export const actRoot = 2;\n');
  await until('write after Add to Watch on the root', () => eventsFor('src/actRoot.ts', atRoot).length === 2, 20000);
  fs.mkdirSync(path.join(root, 'src/[id]'), { recursive: true });
  await sleep(1000);
  await vscode.commands.executeCommand('agentTypewriter.watchOnlyThis', uriOf('src/[id]'));
  assert.deepEqual(includeValue(), ['src/[[]id[]]/**'], 'glob characters in the selection were not escaped');
  await sleep(500);
  const atRoute = timeline.all().length;
  write('src/[id]/page.ts', 'export const page = 1;\n');
  await until('write in a [id] folder after Watch Only This', () => eventsFor('src/[id]/page.ts', atRoute).length === 1, 20000);
  await vscode.commands.executeCommand('agentTypewriter.resetFilters');
  await until('Watch Only This playback', idle);
  console.log('[it] ACT: Watch Only This on the root and on [id] ok');

  // ACT b. Raising maxFileSizeKB while watching takes baselines for files that now fit.
  await cfg().update('maxFileSizeKB', 1, WS);
  await settle();
  const bigText = Array.from({ length: 120 }, (_, i) => `export const big${i} = ${i};\n`).join('');
  const atBig = timeline.all().length;
  write('src/big.ts', bigText);
  await sleep(1500);
  api.recorder.drainHeld();
  assert.deepEqual(eventsFor('src/big.ts', atBig), [], 'a file over maxFileSizeKB was recorded');
  await cfg().update('maxFileSizeKB', 512, WS);
  await until('big.ts baseline after raising maxFileSizeKB', () => api.recorder.hasBaseline(uriOf('src/big.ts')), 20000);
  write('src/big.ts', bigText + 'export const grown = true;\n');
  await until('big.ts recorded', () => eventsFor('src/big.ts', atBig).length > 0, 20000);
  await sleep(500);
  await until('big.ts playback', idle);
  const bigEvents = eventsFor('src/big.ts', atBig);
  assert.equal(bigEvents.length, 1, `expected one big.ts change, got ${bigEvents.length}`);
  assert.equal(bigEvents[0].kind, 'modify');
  assert.equal(bigEvents[0].before, bigText, 'the first change after raising maxFileSizeKB does not start from the file text');
  assert.equal(mirrorText('src/big.ts'), disk('src/big.ts'));
  await cfg().update('maxFileSizeKB', undefined, WS);
  console.log('[it] ACT: raising maxFileSizeKB ok');

  // ACT c. Clear Buffer and Load Session replace changes still held for reordering.
  const quiet = async () => {
    for (let n = -1; n !== timeline.all().length; ) {
      n = timeline.all().length;
      await sleep(reorderWindow + 1500);
    }
    await until('playback before a quiet check', idle);
  };
  const heldNow = (rel: string) => api.recorder.describeActivity().includes(`recorded create ${rel}`);
  await quiet();
  write('src/actHeld.ts', 'export const held = 1;\n');
  await until('actHeld.ts held for reordering', () => heldNow('src/actHeld.ts'), 20000);
  await vscode.commands.executeCommand('agentTypewriter.clear');
  await sleep(reorderWindow + 1500);
  assert.deepEqual(timeline.all().map((e) => e.relPath), [], 'a change held at Clear Buffer came back after it');

  write('src/actSaved.ts', 'export const saved = 1;\n');
  await until('actSaved.ts recorded', () => eventsFor('src/actSaved.ts', 0).length === 1, 20000);
  const actSession = path.join(path.dirname(process.env.IT_EXPECT!), 'act-session.json');
  await vscode.commands.executeCommand('agentTypewriter.saveSession', vscode.Uri.file(actSession));
  const savedPaths = timeline.all().map((e) => e.relPath);
  write('src/actHeld2.ts', 'export const held2 = 1;\n');
  await until('actHeld2.ts held for reordering', () => heldNow('src/actHeld2.ts'), 20000);
  await vscode.commands.executeCommand('agentTypewriter.loadSession', vscode.Uri.file(actSession));
  await sleep(reorderWindow + 1500);
  assert.deepEqual(timeline.all().map((e) => e.relPath), savedPaths, 'a change held at Load Session was appended to the loaded one');
  assert.equal(player.playbackRelPath, undefined, 'Load Session kept the previous playback mirror');
  if (player.isPaused) await vscode.commands.executeCommand('agentTypewriter.togglePause');
  await until('loaded session playback', idle);
  // Loading stops watching, so live edits do not mix into the loaded changes; start again for what follows.
  assert.equal(api.recorder.isRunning, false, 'Load Session kept watching');
  await vscode.commands.executeCommand('agentTypewriter.start');
  await sleep(500);
  console.log('[it] ACT: Clear Buffer and Load Session drain held changes ok');

  // ACT d. A .git file is git metadata: never recorded, unlike a file next to it.
  const libGitDir = `${root}-act-libgit`;
  // One level deep, like otherRepo above: git writes actlib/.git as a gitfile.
  fs.mkdirSync(path.join(root, 'actlib'));
  await sleep(1000);
  const atGitfile = timeline.all().length;
  gitIn(path.join(root, 'actlib'), 'init', '-q', '--separate-git-dir', libGitDir);
  await sleep(2000);
  write('actlib/index.ts', 'export const lib = 1;\n');
  await until('file next to a gitfile recorded', () => eventsFor('actlib/index.ts', atGitfile).length === 1, 20000);
  await sleep(1500);
  api.recorder.drainHeld();
  assert.deepEqual(eventsFor('actlib/.git', atGitfile), [], 'a .git file was recorded');
  await until('gitfile playback', idle);

  // A focus refresh while recording counts worktrees added and removed elsewhere,
  // and a chosen worktree's own .git file gets no baseline and is not recorded.
  const worktreeCount = async () => (await api.refreshCheckouts()).get(folder.uri.toString())?.worktrees;
  const countBefore = await worktreeCount();
  assert.ok(countBefore, 'the folder has no checkouts');
  const sideDir = `${root}-actside`;
  gitIn(root, 'worktree', 'add', '-q', '-b', 'actside', sideDir);
  assert.equal(await worktreeCount(), countBefore + 1, 'a refresh while recording missed a worktree added elsewhere');
  await choose(sideDir);
  await until('actside chosen', () => own() === false, 20000);
  const sideUris = (rel: string) => [sideDir, fs.realpathSync.native(sideDir)].map((d) => vscode.Uri.file(path.join(d, rel)));
  await until('actside baseline', () => sideUris('src/committed1.ts').some((u) => api.recorder.hasBaseline(u)), 20000);
  assert.ok(!sideUris('.git').some((u) => api.recorder.hasBaseline(u)), "the chosen worktree's .git file got a baseline");
  const atSide = timeline.all().length;
  // A trailing newline more, which git ignores, so a baseline would see a change.
  // In place: git hides the file on Windows, and a hidden file can't be opened for truncation.
  const sideGitfile = fs.readFileSync(path.join(sideDir, '.git'), 'utf8');
  fs.writeFileSync(path.join(sideDir, '.git'), sideGitfile + '\n', { flag: 'r+' });
  await sleep(1500);
  api.recorder.drainHeld();
  assert.deepEqual(since(atSide).map((e) => `${e.kind} ${e.relPath}`), [], "rewriting the chosen worktree's .git file was recorded");
  await choose('');
  await until('own checkout after actside', () => own() === true, 20000);
  gitIn(root, 'worktree', 'remove', '--force', sideDir);
  assert.equal(await worktreeCount(), countBefore, 'a refresh while recording missed a worktree removed elsewhere');
  console.log('[it] ACT: gitfiles and worktree count while recording ok');

  // ACT e. The repository file's history settings beat the user's at the next
  // activation: restore.ts checks every change comes back and stays saved.
  const repoBefore = fs.existsSync(repoFile) ? JSON.parse(fs.readFileSync(repoFile, 'utf8')) : {};
  fs.writeFileSync(repoFile, JSON.stringify({ ...repoBefore, historyLimit: 1000, persistHistory: true }));
  await sleep(2000);
  await cfg().update('historyLimit', 10, vscode.ConfigurationTarget.Global);
  await cfg().update('persistHistory', false, vscode.ConfigurationTarget.Global);
  const atHistory = timeline.all().length;
  for (let i = 0; i < 12; i++) {
    write(`src/actHistory${i}.ts`, `export const history${i} = ${i};\n`);
    await sleep(150);
  }
  await until('history changes recorded', () => since(atHistory).filter((e) => e.relPath.startsWith('src/actHistory')).length === 12, 20000);
  await until('history playback', idle);
  assert.ok(timeline.all().length > 12, 'the user historyLimit cut the buffer though the repository file sets one');
  assert.ok(api.store?.isRunning, 'the user persistHistory stopped saving though the repository file turns it on');
  console.log(`[it] ACT: repository file history settings ok (${timeline.all().length} changes)`);
}

/** Edge cases of recording edits, then REC2 (baselines) and REC3 (worktree lifecycle). */
async function edits(c: Context): Promise<void> {
  const { api, timeline, root, write, disk, mirrorText, idle, reorderWindow, lf, cfg, WS, uriOf, eventsFor, gitIn, own, choose, since } = c;

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
    // A read-only file is how these sections make an editor save fail; root can write it anyway.
    const canFailSaves = process.getuid?.() !== 0;

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
    let atChain2 = timeline.all().length;
    if (canFailSaves) {
      await created('src/chain2.ts', 'export const w = 0;\n');
      const chainPath = path.join(root, 'src/chain2.ts');
      const chainDoc = await vscode.workspace.openTextDocument(chainPath);
      const chainEd = await vscode.window.showTextDocument(chainDoc);
      await chainEd.edit((b) => b.insert(new vscode.Position(0, 0), '// unsaved by me\n'));
      fs.chmodSync(chainPath, 0o444);
      const chainSaved = await chainDoc.save();
      fs.chmodSync(chainPath, 0o644);
      assert.equal(chainSaved, false, 'expected the save of a read-only file to fail');
      atChain2 = timeline.all().length;
      write('src/chain2.ts', 'export const w = 1;\n');
      await sleep(300);
      write('src/chain2.ts', 'export const w = 2;\n');
      await until('last chain2 write recorded', () => eventsFor('src/chain2.ts', atChain2).at(-1)?.after === 'export const w = 2;\n');
      await settled();
      await vscode.window.showTextDocument(chainDoc);
      await vscode.commands.executeCommand('workbench.action.revertAndCloseActiveEditor');
      assertChain('src/chain2.ts', atChain2, 'export const w = 0;\n', 'export const w = 2;\n');
    }
    await setting('debounceMs', 100);
    console.log(`[it] same-file changes chain ok (${eventsFor('src/chain.ts', atChain).length} and ${eventsFor('src/chain2.ts', atChain2).length} changes)`);

    // R3. A save that fails (here the file is read-only) is not the next
    // outside write's before text.
    if (canFailSaves) {
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
    }

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
    // Let the filter refresh R4's setting change started finish first: a
    // refresh queued now runs after it.
    await api.recorder.refreshFilter();
    await settled();
    await created('src/linkTarget.ts', 'export const target = 1;\n');
    fs.mkdirSync(path.join(root, 'src/linkDirReal'));
    await sleep(1000);
    await created('src/linkDirReal/a.ts', 'export const inLinkedDir = 1;\n');
    let linked = true;
    const atLinks = timeline.all().length;
    try {
      fs.symlinkSync('linkTarget.ts', path.join(root, 'src/linkFile.ts'), 'file');
      fs.symlinkSync('linkDirReal', path.join(root, 'src/linkDir'), 'dir');
    } catch (err) {
      linked = false;
      console.log(`[it] symlinks unavailable here (${(err as NodeJS.ErrnoException).code}); skipping the symlink save check`);
    }
    if (linked) {
      // A new link to a file is recorded as created. The Windows watcher can
      // report it seconds later, so wait for it before saving through the link.
      const linkCreated = () => eventsFor('src/linkFile.ts', atLinks).length > 0;
      for (const start = Date.now(); !linkCreated() && Date.now() - start < 20000; ) await sleep(100);
      if (!linkCreated()) console.log('[it] the watcher did not report the new file link; checking the save anyway');
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
      const linkEvents = relEvents(atLink);
      if (linkEvents.length > 0) console.log(`[it] recorder activity:\n${api.recorder.describeActivity()}`);
      assert.deepEqual(linkEvents, [], 'a save through a symlink was recorded');
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
    // The watcher may report this as one change of src/thing.ts.
    fs.rmSync(path.join(root, 'src/thing.ts'), { recursive: true });
    write('src/thing.ts', 'brand new\n');
    await until('file at the old path again', () => eventsFor('src/thing.ts', atBack2).length > 0);
    await until('directory file deleted', () => eventsFor('src/thing.ts/inner.ts', atBack2).some((e) => e.kind === 'delete'));
    await settled();
    assert.deepEqual(eventsFor('src/thing.ts', atBack2).map((e) => [e.kind, e.before]), [['create', '']]);
    assert.equal(api.recorder.hasBaseline(uriOf('src/thing.ts/inner.ts')), false, 'a file of the replaced directory kept its baseline');
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

    // R10. A case-only rename of a directory deletes each file under the old spelling.
    fs.mkdirSync(path.join(root, 'src/CaseDir'));
    await sleep(1000);
    await created('src/CaseDir/a.ts', 'export const inCaseDir = 1;\n');
    const watchedCaseDir = api.recorder.watchedCount;
    const atCaseDir = timeline.all().length;
    fs.renameSync(path.join(root, 'src/CaseDir'), path.join(root, 'src/casedir'));
    await until('directory case rename recorded', () => ['delete src/CaseDir/a.ts', 'create src/casedir/a.ts'].every((x) => relEvents(atCaseDir).includes(x)));
    await settled();
    assert.deepEqual([...relEvents(atCaseDir)].sort(), ['create src/casedir/a.ts', 'delete src/CaseDir/a.ts']);
    assert.equal(api.recorder.hasBaseline(uriOf('src/CaseDir/a.ts')), false, 'the old directory spelling kept its baseline');
    assert.equal(api.recorder.watchedCount, watchedCaseDir, 'a case-only directory rename grew the watched count');
    console.log('[it] case-only directory rename ok');

    // R11. A directory created inside an excluded tree is not walked.
    const restoreExclude = cfg().inspect('exclude')?.workspaceValue;
    await setting('exclude', [...cfg().get<string[]>('exclude', []), 'src/skipme/**']);
    await until('exclude to apply', () => !api.recorder.matches(uriOf('src/skipme/x.ts')), 10000);
    fs.mkdirSync(path.join(root, 'src/skipme'));
    await sleep(1000);
    const preparedSkip = `${root}-skip`;
    fs.mkdirSync(path.join(preparedSkip, 'deep'), { recursive: true });
    fs.writeFileSync(path.join(preparedSkip, 'deep', 'x.ts'), 'export const skipped = 1;\n');
    fs.renameSync(preparedSkip, path.join(root, 'src/skipme/inner'));
    await sleep(1500);
    assert.match(api.recorder.describeActivity(), /watcher create src\/skipme\/inner/, 'the watcher did not report the moved-in directory');
    assert.doesNotMatch(api.recorder.describeActivity(), /in directory create src\/skipme/, 'a directory inside an excluded tree was walked');
    await setting('exclude', restoreExclude);
    console.log('[it] excluded trees not walked ok');

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

  // REC2: baselines. Fixtures are the committed files under src/rec2/ (runTest.ts).
  {
    const filesCfg = () => vscode.workspace.getConfiguration('files');
    const restoreReorder = cfg().inspect('reorderWindowMs')?.workspaceValue;
    await cfg().update('reorderWindowMs', 0, WS);
    const writeBytes = (rel: string, data: Uint8Array) => {
      for (let attempt = 0; ; attempt++) {
        try {
          return fs.writeFileSync(path.join(root, rel), data);
        } catch (err) {
          const code = (err as NodeJS.ErrnoException).code;
          if ((code !== 'EBUSY' && code !== 'EPERM') || attempt >= 100) throw err;
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
        }
      }
    };
    const restart = async () => {
      await vscode.commands.executeCommand('agentTypewriter.stop');
      await vscode.commands.executeCommand('agentTypewriter.start');
    };
    const settledRec2 = async () => {
      await sleep(1000);
      api.recorder.drainHeld();
      await until('playback to settle', idle);
    };
    /** Edits a file that has a baseline and checks its change starts from `before`. */
    const firstEdit = async (rel: string, before: string, after: string, what: string) => {
      await until(`${rel} baseline`, () => api.recorder.hasBaseline(uriOf(rel)), 20000);
      const at = timeline.all().length;
      write(rel, after);
      await until(`${what}: ${rel} recorded`, () => eventsFor(rel, at).length > 0, 20000);
      await settledRec2();
      assert.deepEqual(eventsFor(rel, at).map((e) => [e.kind, e.before]), [['modify', before]], `${what}: wrong change for ${rel}`);
    };

    // E1. files.exclude hides a file from the Explorer, not from the watcher: it still gets a baseline.
    await filesCfg().update('exclude', { '**/rec2/hidden.ts': true }, WS);
    await restart();
    await firstEdit('src/rec2/hidden.ts', lf(disk('src/rec2/hidden.ts')), 'export const hidden = 2;\n', 'files.exclude');
    await filesCfg().update('exclude', undefined, WS);
    console.log('[it] REC2: files.exclude does not cost a baseline ok');

    // E2. files.watcherExclude: hidden files get no baseline, and the setting applies live.
    fs.mkdirSync(path.join(root, 'src/wx'), { recursive: true });
    await sleep(1000);
    write('src/wx/w.ts', 'export const w = 1;\n');
    await until('wx/w.ts baseline', () => api.recorder.hasBaseline(uriOf('src/wx/w.ts')), 20000);
    await filesCfg().update('watcherExclude', { '**/wx/**': true }, WS);
    await until('watcherExclude to apply', () => !api.recorder.matches(uriOf('src/wx/w.ts')), 10000);
    await until('baseline of a file hidden from the watcher dropped', () => !api.recorder.hasBaseline(uriOf('src/wx/w.ts')), 10000);
    await filesCfg().update('watcherExclude', undefined, WS);
    await until('watcherExclude removal to apply', () => api.recorder.matches(uriOf('src/wx/w.ts')), 10000);
    // The replaced watchers need a moment to start reporting.
    await sleep(2000);
    await firstEdit('src/wx/w.ts', 'export const w = 1;\n', 'export const w = 2;\n', 'watcherExclude removed');
    console.log('[it] REC2: files.watcherExclude ok');

    // E3. Exclude globs that ripgrep reads differently: files they do not cover keep their baselines.
    const restoreExcl = cfg().inspect('exclude')?.workspaceValue;
    fs.mkdirSync(path.join(root, 'src/notes'), { recursive: true });
    await sleep(1000);
    write('src/notes/todo.ts', 'export const todo = 1;\n');
    await settledRec2();
    await cfg().update('exclude', [...cfg().get<string[]>('exclude', []), '**/*.{log', '**/notes'], WS);
    await sleep(500);
    await restart();
    await firstEdit('src/notes/todo.ts', 'export const todo = 1;\n', 'export const todo = 2;\n', 'odd exclude globs');
    await cfg().update('exclude', restoreExcl, WS);
    await sleep(500);
    console.log('[it] REC2: exclude globs ok');

    // E4. A file stamped in the future still gets a baseline.
    write('src/rec2/future.ts', 'export const future = 1;\n');
    await settledRec2();
    const future = new Date('2035-01-01T00:00:00Z');
    fs.utimesSync(path.join(root, 'src/rec2/future.ts'), future, future);
    await restart();
    await firstEdit('src/rec2/future.ts', 'export const future = 1;\n', 'export const future = 2;\n', 'future mtime');
    console.log('[it] REC2: future mtime ok');

    // E5, E6. Symlinks: files under a linked directory get no baseline; a linked file does.
    const dirLink = path.join(root, 'src/rec2link');
    const unlinkDir = () => {
      // A junction on Windows is removed like a directory.
      try {
        fs.unlinkSync(dirLink);
      } catch {
        fs.rmdirSync(dirLink);
      }
    };
    let linked = true;
    try {
      fs.symlinkSync(path.join(root, 'src/rec2'), dirLink, 'junction');
      try {
        fs.symlinkSync('agents.ts', path.join(root, 'src/rec2/claude.ts'), 'file');
      } catch (err) {
        unlinkDir();
        throw err;
      }
    } catch (err) {
      linked = false;
      console.log(`[it] REC2: symlinks unavailable here (${(err as NodeJS.ErrnoException).code}); skipping the symlink checks`);
    }
    if (linked) {
      await settledRec2();
      await restart();
      await until('rec2 baselines', () => api.recorder.hasBaseline(uriOf('src/rec2/agents.ts')), 20000);
      assert.equal(api.recorder.hasBaseline(uriOf('src/rec2link/agents.ts')), false, 'a file under a linked directory has a baseline');
      assert.ok(api.recorder.hasBaseline(uriOf('src/rec2/claude.ts')), 'a linked file has no baseline');
      // As sed -i does: a temp file renamed over the link.
      const agentsText = lf(disk('src/rec2/agents.ts'));
      const atLink = timeline.all().length;
      write('src/rec2/claude.tmp', agentsText.replace('one', 'ONE'));
      fs.renameSync(path.join(root, 'src/rec2/claude.tmp'), path.join(root, 'src/rec2/claude.ts'));
      await until('link replaced by a file recorded', () => eventsFor('src/rec2/claude.ts', atLink).length > 0, 20000);
      await settledRec2();
      assert.deepEqual(eventsFor('src/rec2/claude.ts', atLink).map((e) => [e.kind, e.before]), [['modify', agentsText]]);
      // A link put in place of a committed file.
      const plainText = lf(disk('src/rec2/plain.ts'));
      const atPlain = timeline.all().length;
      fs.rmSync(path.join(root, 'src/rec2/plain.ts'));
      fs.symlinkSync('agents.ts', path.join(root, 'src/rec2/plain.ts'), 'file');
      await until('file replaced by a link recorded', () => eventsFor('src/rec2/plain.ts', atPlain).length > 0, 20000);
      await settledRec2();
      assert.deepEqual(eventsFor('src/rec2/plain.ts', atPlain).map((e) => [e.kind, e.before, e.after]), [['modify', plainText, agentsText]]);
      unlinkDir();
      fs.rmSync(path.join(root, 'src/rec2/plain.ts'));
      write('src/rec2/plain.ts', plainText);
      await settledRec2();
      console.log('[it] REC2: symlinks ok');
    }

    // E7. A committed file over maxFileSizeKB gets no git baseline and is not recorded.
    await cfg().update('maxFileSizeKB', 1, WS);
    await until('big.ts baseline dropped', () => !api.recorder.hasBaseline(uriOf('src/rec2/big.ts')), 20000);
    assert.ok(api.recorder.hasBaseline(uriOf('src/rec2/toggle.ts')), 'a small committed file lost its baseline');
    const atBig = timeline.all().length;
    write('src/rec2/big.ts', disk('src/rec2/big.ts') + '// more\n');
    await settledRec2();
    assert.deepEqual(eventsFor('src/rec2/big.ts', atBig), [], 'a file over maxFileSizeKB was recorded');
    await cfg().update('maxFileSizeKB', undefined, WS);
    await until('big.ts baseline back', () => api.recorder.hasBaseline(uriOf('src/rec2/big.ts')), 20000);
    console.log('[it] REC2: oversized committed file ok');

    // E8. Toggling gitBaselines while an agent writes keeps the write.
    const toggleText = lf(disk('src/rec2/toggle.ts'));
    const atToggle = timeline.all().length;
    const toggled = cfg().update('gitBaselines', false, WS);
    write('src/rec2/toggle.ts', toggleText + 'export const toggled = 1;\n');
    await toggled;
    await until('write during the toggle recorded', () => eventsFor('src/rec2/toggle.ts', atToggle).length > 0, 20000);
    await settledRec2();
    assert.deepEqual(eventsFor('src/rec2/toggle.ts', atToggle).map((e) => [e.kind, e.before]), [['modify', toggleText]]);
    await cfg().update('gitBaselines', true, WS);
    await sleep(1000);
    console.log('[it] REC2: write while toggling gitBaselines ok');

    // E9. Files are read in their encoding: an editor save of a windows-1252 file is an own save.
    await filesCfg().update('encoding', 'windows1252', WS);
    writeBytes('src/rec2/latin.ts', Buffer.from('export const s = "café";\n', 'latin1'));
    await until('latin.ts baseline', () => api.recorder.hasBaseline(uriOf('src/rec2/latin.ts')), 20000);
    await settledRec2();
    const atLatin = timeline.all().length;
    const latinDoc = await vscode.workspace.openTextDocument(path.join(root, 'src/rec2/latin.ts'));
    assert.equal(lf(latinDoc.getText()), 'export const s = "café";\n', 'VS Code did not read the file as windows-1252');
    const latinEd = await vscode.window.showTextDocument(latinDoc);
    await latinEd.edit((b) => b.insert(new vscode.Position(1, 0), 'export const t = "naïve";\n'));
    await latinDoc.save();
    const savedLatin = lf(latinDoc.getText());
    await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
    await settledRec2();
    assert.deepEqual(eventsFor('src/rec2/latin.ts', atLatin), [], 'an own save of a windows-1252 file was recorded');
    writeBytes('src/rec2/latin.ts', Buffer.from(savedLatin + 'export const u = "über";\n', 'latin1'));
    await until('outside write to latin.ts recorded', () => eventsFor('src/rec2/latin.ts', atLatin).length > 0, 20000);
    await settledRec2();
    assert.deepEqual(
      eventsFor('src/rec2/latin.ts', atLatin).map((e) => [e.kind, e.before, lf(e.after)]),
      [['modify', savedLatin, savedLatin + 'export const u = "über";\n']],
    );
    await filesCfg().update('encoding', undefined, WS);
    // UTF-16 with a byte order mark is text, not binary.
    const utf16 = (text: string) => Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text, 'utf16le')]);
    const atWide = timeline.all().length;
    writeBytes('src/rec2/wide.ts', utf16('export const wide = 1;\n'));
    await until('UTF-16 file created', () => eventsFor('src/rec2/wide.ts', atWide).length > 0, 20000);
    await settledRec2();
    writeBytes('src/rec2/wide.ts', utf16('export const wide = 2;\n'));
    await until('UTF-16 file changed', () => eventsFor('src/rec2/wide.ts', atWide).length > 1, 20000);
    await settledRec2();
    assert.deepEqual(eventsFor('src/rec2/wide.ts', atWide).map((e) => [e.kind, e.before]), [
      ['create', ''],
      ['modify', 'export const wide = 1;\n'],
    ]);
    console.log('[it] REC2: file encodings ok');

    await cfg().update('reorderWindowMs', restoreReorder, WS);
    await sleep(500);
  }

  // REC3: worktree lifecycle and scope refresh. Worktrees are made here, each
  // next to the workspace or under .worktrees/, and removed again.
  {
    const restoreReorder = cfg().inspect('reorderWindowMs')?.workspaceValue;
    await cfg().update('reorderWindowMs', 0, WS);
    // Windows can briefly hold a directory git renames or removes; retry the command.
    const gitRetry = async (cwd: string, ...args: string[]) => {
      for (let attempt = 0; ; attempt++) {
        try {
          return gitIn(cwd, ...args);
        } catch (err) {
          if (attempt >= 20) throw err;
          await sleep(250);
        }
      }
    };
    const writeAt = (file: string, text: string) => {
      for (let attempt = 0; ; attempt++) {
        try {
          fs.mkdirSync(path.dirname(file), { recursive: true });
          return fs.writeFileSync(file, text);
        } catch (err) {
          const code = (err as NodeJS.ErrnoException).code;
          if ((code !== 'EBUSY' && code !== 'EPERM') || attempt >= 100) throw err;
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
        }
      }
    };
    const rm = async (p: string) => {
      for (let attempt = 0; ; attempt++) {
        try {
          return fs.rmSync(p, { recursive: true, force: true });
        } catch (err) {
          const code = (err as NodeJS.ErrnoException).code;
          if ((code !== 'EBUSY' && code !== 'EPERM' && code !== 'ENOTEMPTY') || attempt >= 100) throw err;
          await sleep(100);
        }
      }
    };
    const skipped = (dir: string) => !api.recorder.matches(vscode.Uri.file(path.join(dir, 'src', 'probe.ts')));
    /** Waits past the debounce, the worktree refresh and a chosen worktree's delete hold, then checks nothing was recorded. */
    const nothingSince = async (from: number, what: string) => {
      await sleep(4500);
      api.recorder.drainHeld();
      assert.deepEqual(
        since(from).map((e) => `${e.kind} ${e.relPath}`),
        [],
        what,
      );
    };

    // W1. A worktree moved into the folder, then within it, is skipped right
    // away, with or without a .git event; removing it records nothing.
    const outsideWt = `${root}-rec3-out`;
    await gitRetry(root, 'worktree', 'add', '-q', '-b', 'rec3-out', outsideWt);
    await sleep(1000);
    const atMove = timeline.all().length;
    const movedIn = path.join(root, '.worktrees', 'moved');
    await gitRetry(root, 'worktree', 'move', outsideWt, movedIn);
    await until('moved-in worktree skipped', () => skipped(movedIn), 20000);
    writeAt(path.join(movedIn, 'src', 'movedNew.ts'), 'export const movedNew = 1;\n');
    writeAt(path.join(movedIn, 'src', 'committed1.ts'), "export const moved = 'in';\n");
    await nothingSince(atMove, 'a worktree moved into the folder was recorded');
    const movedOn = path.join(root, '.worktrees', 'moved2');
    await gitRetry(root, 'worktree', 'move', movedIn, movedOn);
    await until('worktree moved within the folder skipped', () => skipped(movedOn), 20000);
    writeAt(path.join(movedOn, 'src', 'committed1.ts'), "export const moved = 'on';\n");
    await nothingSince(atMove, 'a worktree moved within the folder was recorded');
    await gitRetry(root, 'worktree', 'remove', '--force', movedOn);
    await nothingSince(atMove, 'removing a nested worktree recorded its files');
    console.log('[it] REC3: moved worktrees ok');

    // W2. A nested worktree whose .git file is deleted, the first step of
    // removing it on Windows, is still skipped: no baselines, no deletes.
    const pruneDir = path.join(root, '.worktrees', 'prune');
    await gitRetry(root, 'worktree', 'add', '-q', '-b', 'rec3-prune', '.worktrees/prune');
    await until('new nested worktree skipped', () => skipped(pruneDir), 20000);
    await sleep(1500);
    const atPrune = timeline.all().length;
    await rm(path.join(pruneDir, '.git'));
    await sleep(2000);
    assert.equal(api.recorder.hasBaseline(vscode.Uri.file(path.join(pruneDir, 'src', 'committed1.ts'))), false, 'a worktree without its .git got baselines');
    assert.ok(skipped(pruneDir), 'a worktree without its .git is no longer skipped');
    await rm(path.join(pruneDir, 'src', 'committed1.ts'));
    await nothingSince(atPrune, 'a file deleted in a worktree without its .git was recorded');
    await rm(pruneDir);
    await gitRetry(root, 'worktree', 'prune');
    await nothingSince(atPrune, 'removing the rest of a worktree without its .git was recorded');
    console.log('[it] REC3: worktree without its .git ok');

    // W3. Another repository's worktree, and a submodule whose path ends in
    // worktrees/<name>, are not this repository's checkouts: they are recorded.
    const otherRepo2 = `${root}-rec3-other`;
    fs.mkdirSync(otherRepo2);
    gitIn(otherRepo2, 'init', '-q');
    fs.writeFileSync(path.join(otherRepo2, 'foreign.ts'), 'export const foreign = 1;\n');
    gitIn(otherRepo2, 'add', '-A');
    gitIn(otherRepo2, 'commit', '-q', '-m', 'initial');
    // One level deep: Linux watchers can miss a directory created inside another new one.
    fs.mkdirSync(path.join(root, 'rec3'));
    await sleep(1000);
    fs.mkdirSync(path.join(root, 'rec3', 'worktrees'));
    await sleep(1000);
    const atForeign = timeline.all().length;
    await gitRetry(otherRepo2, 'worktree', 'add', '-q', '-b', 'bwt', path.join(root, 'rec3', 'bwt'));
    await until('foreign worktree checkout recorded', () => eventsFor('rec3/bwt/foreign.ts', atForeign).some((e) => e.kind === 'create'), 20000);
    await gitRetry(root, '-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', otherRepo2, 'rec3/worktrees/foo');
    await until('submodule checkout recorded', () => eventsFor('rec3/worktrees/foo/foreign.ts', atForeign).some((e) => e.kind === 'create'), 20000);
    await until('foreign checkout playback', idle);
    await gitRetry(otherRepo2, 'worktree', 'remove', '--force', path.join(root, 'rec3', 'bwt'));
    await gitRetry(root, 'rm', '-q', '-f', 'rec3/worktrees/foo');
    await gitRetry(root, 'rm', '-q', '-f', '.gitmodules');
    // The submodule's repository stays under .git/modules: git's object files are read-only, which Windows won't delete.
    await sleep(2000);
    api.recorder.drainHeld();
    await until('foreign removal playback', idle);
    console.log('[it] REC3: foreign worktree and submodule ok');

    // W4. In a chosen worktree, a real delete is recorded from its baseline;
    // removing the worktree records nothing, even for a file deleted well
    // before git got to its .git.
    const rec3Side = `${root}-rec3-side`;
    const sideLabel = path.basename(rec3Side);
    const sideFile = (rel: string) => [rec3Side, fs.realpathSync.native(rec3Side)].map((d) => vscode.Uri.file(path.join(d, rel)));
    await gitRetry(root, 'worktree', 'add', '-q', '-b', 'rec3-side', rec3Side);
    await choose(rec3Side);
    await until('rec3 sibling chosen', () => own() === false, 20000);
    await until('rec3 sibling baselines', () => sideFile('src/committed3.ts').some((u) => api.recorder.hasBaseline(u)), 20000);
    const committed3 = lf(fs.readFileSync(path.join(rec3Side, 'src', 'committed3.ts'), 'utf8'));
    const atRealDelete = timeline.all().length;
    await rm(path.join(rec3Side, 'src', 'committed3.ts'));
    const deleted3 = `${sideLabel}/src/committed3.ts`;
    await until('delete in the chosen worktree recorded', () => eventsFor(deleted3, atRealDelete).length > 0, 20000);
    assert.deepEqual(eventsFor(deleted3, atRealDelete).map((e) => [e.kind, e.before]), [['delete', committed3]]);
    await until('chosen worktree delete playback', idle);
    const atRemoval = timeline.all().length;
    await rm(path.join(rec3Side, 'src', 'committed2.ts'));
    await sleep(800);
    await gitRetry(root, 'worktree', 'remove', '--force', rec3Side);
    await until('fallback after removing the rec3 sibling', () => own() === true, 20000);
    await nothingSince(atRemoval, 'removing the chosen worktree recorded its files as deleted');
    console.log('[it] REC3: chosen worktree deletes ok');

    // W5. Stop right after Start: nothing keeps recording, and the next
    // start's first change starts from the disk text, not an earlier save.
    write('src/rec3save.ts', 'S\n');
    await until('rec3save.ts baseline', () => api.recorder.hasBaseline(uriOf('src/rec3save.ts')), 20000);
    await sleep(1000);
    api.recorder.drainHeld();
    await until('rec3save playback', idle);
    await vscode.commands.executeCommand('agentTypewriter.stop');
    const racing = api.recorder.start();
    api.recorder.stop();
    await racing;
    assert.equal(api.recorder.isRunning, false, 'stop during start left the recorder running');
    const saveDoc = await vscode.workspace.openTextDocument(path.join(root, 'src/rec3save.ts'));
    const saveEd = await vscode.window.showTextDocument(saveDoc);
    await saveEd.edit((b) => b.replace(new vscode.Range(0, 0, saveDoc.lineCount, 0), 'U\n'));
    await saveDoc.save();
    await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
    write('src/rec3save.ts', 'A\n');
    await sleep(500);
    const atRestart = timeline.all().length;
    await api.recorder.start();
    await sleep(500);
    write('src/rec3save.ts', 'A2\n');
    await until('change after restart recorded', () => eventsFor('src/rec3save.ts', atRestart).length > 0, 20000);
    await sleep(1000);
    api.recorder.drainHeld();
    assert.deepEqual(
      since(atRestart).map((e) => [e.relPath, e.before, lf(e.after)]),
      [['src/rec3save.ts', 'A\n', 'A2\n']],
    );
    await vscode.commands.executeCommand('agentTypewriter.start');
    await until('rec3 restart playback', idle);
    console.log('[it] REC3: stop during start ok');

    await cfg().update('reorderWindowMs', restoreReorder, WS);
    await sleep(500);
  }
}

/** Section 18: queued changes and open mirror tabs for restore.ts, and the checkout it expects. */
async function leaveForReload(c: Context): Promise<void> {
  const { api, timeline, write, disk, mirrorText, idle, nestedDir, choose } = c;

  // --- 18. Leave three queued changes behind for the reload check in restore.ts,
  // which runs in a second VS Code launch on the same workspace. Two mirror
  // tabs stay open across it: an LF file played to the end, and a CRLF file
  // played once with a second change queued behind it.
  await until('idle before reload setup', idle);
  // restore.ts checks the clear survives: only files changed after it are highlighted.
  write('src/beforeClear.ts', 'export const beforeClear = 1;\n');
  await until('beforeClear.ts to play', () => idle() && mirrorText('src/beforeClear.ts') === disk('src/beforeClear.ts'));
  assert.ok(highlightedFiles(timeline).includes('src/beforeClear.ts'), 'a file changed before the clear is not highlighted');
  await vscode.commands.executeCommand('agentTypewriter.clearHighlights');
  write('src/tabPlayed.ts', 'export const tabPlayed = 1;\n');
  await sleep(300);
  write('src/tabQueued.ts', 'export const tabQueued = 1;\r\n');
  await until('mirror tabs to play', () => idle() && ['src/tabPlayed.ts', 'src/tabQueued.ts'].every((rel) => mirrorText(rel) === disk(rel)));
  if (!api.player.isPaused) await vscode.commands.executeCommand('agentTypewriter.togglePause');
  const beforeQueue = timeline.all().length;
  write('src/tabQueued.ts', 'export const tabQueued = 2;\r\n');
  await sleep(300);
  write('src/queued1.ts', 'export const queued1 = 1;\n');
  await sleep(300);
  write('src/queued2.ts', 'export const queued2 = 2;\n');
  await until('queued changes recorded', () => timeline.all().length >= beforeQueue + 3, 20000);
  assert.equal(timeline.pendingCount(), 3, 'expected three queued changes');
  // What each tab shows now, LF text plus its line ending, is what it must show after the reload.
  const shown = (rel: string) => {
    const doc = vscode.workspace.textDocuments.find((d) => d.uri.scheme === 'agent-typewriter' && d.uri.path === '/' + rel)!;
    return { text: doc.getText().replace(/\r\n/g, '\n'), eol: doc.eol === vscode.EndOfLine.CRLF ? '\r\n' : '\n' };
  };
  const mirrorTabs = Object.fromEntries(['src/tabPlayed.ts', 'src/tabQueued.ts'].map((rel) => [rel, shown(rel)]));
  assert.deepEqual(mirrorTabs['src/tabPlayed.ts'], { text: 'export const tabPlayed = 1;\n', eol: '\n' });
  assert.deepEqual(mirrorTabs['src/tabQueued.ts'], { text: 'export const tabQueued = 1;\n', eol: '\r\n' }, 'the queued change was typed while paused');
  const highlighted = highlightedFiles(timeline);
  for (const rel of ['src/tabPlayed.ts', 'src/tabQueued.ts']) assert.ok(highlighted.includes(rel), `${rel} is not highlighted after the clear`);
  assert.ok(!highlighted.includes('src/beforeClear.ts'), 'a file changed before the clear is still highlighted');
  assert.ok(api.store, 'no timeline store');
  await api.store.flush();
  fs.writeFileSync(
    process.env.IT_EXPECT!,
    JSON.stringify({ events: timeline.all().map(persisted), pending: timeline.pendingCount(), mirrorTabs, highlighted }),
  );
  console.log(`[it] left ${timeline.all().length} changes (3 queued) for the reload check`);
  // Stop first, so choosing only stores the choice; restore.ts checks it survives the reload.
  await vscode.commands.executeCommand('agentTypewriter.stop');
  await choose(nestedDir);
}


/** Files whose mirror text differs from their highlight baseline, sorted. */
export function highlightedFiles(t: Timeline): string[] {
  const texts = t.mirrorStates();
  return [...baselines(t.all(), t.cursor, t.highlightClears)]
    .filter(([relPath, base]) => texts.has(relPath) && texts.get(relPath)!.text !== base)
    .map(([relPath]) => relPath)
    .sort();
}

/** The recorded fields a restored change must keep. */
export function persisted(e: { relPath: string; uri: string; kind: string; before: string; after: string; eol: string; time: number }) {
  return { relPath: e.relPath, uri: e.uri, kind: e.kind, before: e.before, after: e.after, eol: e.eol, time: e.time };
}
