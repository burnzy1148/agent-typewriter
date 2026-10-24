// A hands-on tour of replay for manual testing. It builds the extension, makes
// a throwaway git repository, opens it in a VS Code window running the
// extension from this checkout (in a throwaway profile), then plays the part
// of an agent: one scenario per step, each saying what to watch for. A
// checklist of things to try by hand follows at the end.
//
//   node scripts/replay-tour.mjs [--auto] [--delay 8000] [--dir <path>] [--no-launch]
//
// --auto runs every step without waiting for Enter, --delay ms apart.
// --dir uses that folder instead of a new temporary one; it must not exist yet.
// --no-launch only prepares the repository and plays the agent, for a window
// you open yourself (start watching there before the first step).
import { spawn, spawnSync, execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as readline from 'node:readline/promises';
import { parseArgs } from 'node:util';

const { values: opts } = parseArgs({
  options: {
    auto: { type: 'boolean', default: false },
    delay: { type: 'string', default: '8000' },
    dir: { type: 'string' },
    'no-launch': { type: 'boolean', default: false },
  },
});

const root = path.resolve(import.meta.dirname, '..');
// Holds the default repository and the throwaway VS Code profile; made only when one is needed.
let tmpDir;
const tmp = () => (tmpDir ??= fs.mkdtempSync(path.join(os.tmpdir(), 'typewriter-tour-')));
const repo = opts.dir ? path.resolve(opts.dir) : path.join(tmp(), 'shop');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const git = (...args) =>
  execFileSync('git', ['-c', 'user.name=Replay Tour', '-c', 'user.email=tour@example.invalid', '-c', 'commit.gpgsign=false', '-c', 'core.autocrlf=false', ...args], {
    cwd: repo,
    stdio: 'ignore',
  });

// ------------------------------------------------------------------ files

const lines = (n, make) => Array.from({ length: n }, (_, i) => make(i + 1)).join('');
const cart = `import { Item } from './item';

export function subtotal(items: Item[]): number {
  let amount = 0;
  for (const item of items) amount += item.price * item.qty;
  return amount;
}

export function count(items: Item[]): number {
  return items.reduce((n, item) => n + item.qty, 0);
}
`;
const longFile = `// A long file, for scrolling and for big removals.\n` + lines(140, (i) => `export const value${i} = ${i * 3}; // line ${i + 1}\n`);
const notes = `# Notes\n\n- Coupons are case-insensitive.\n- Totals round to cents.\n`;
const crlf = 'export const greeting = "hello";\r\nexport const farewell = "bye";\r\n';
const files = {
  'src/item.ts': 'export interface Item {\n  name: string;\n  price: number;\n  qty: number;\n}\n',
  'src/cart.ts': cart,
  'src/long.ts': longFile,
  'src/crlf.ts': crlf,
  'src/legacy.ts': 'export const legacy = true;\nexport function old() {\n  return "old";\n}\n',
  'src/doomed.ts': 'export function doomed() {\n  return "this file is about to be deleted";\n}\n',
  'docs/notes.md': notes,
};

const write = (rel, text) => {
  fs.mkdirSync(path.dirname(path.join(repo, rel)), { recursive: true });
  fs.writeFileSync(path.join(repo, rel), text);
};
const read = (rel) => fs.readFileSync(path.join(repo, rel), 'utf8');
const edit = (rel, fn) => write(rel, fn(read(rel)));

function makeRepo() {
  if (fs.existsSync(repo)) throw new Error(`${repo} already exists; pass a new --dir`);
  fs.mkdirSync(repo, { recursive: true });
  git('init', '-q', '-b', 'main');
  for (const [rel, text] of Object.entries(files)) write(rel, text);
  write('.vscode/settings.json', JSON.stringify({
    'agentTypewriter.autoStart': true,
    'agentTypewriter.extensions': ['ts', 'md'],
    'agentTypewriter.persistHistory': true,
  }, null, 2) + '\n');
  git('add', '-A');
  git('commit', '-q', '-m', 'Start the shop');
  // History for Replay Git Commits: main..feature has three commits.
  git('checkout', '-q', '-b', 'feature');
  write('src/discount.ts', 'export function discount(amount: number, percent: number): number {\n  return amount * (1 - percent / 100);\n}\n');
  git('add', '-A');
  git('commit', '-q', '-m', 'Add discount');
  edit('src/cart.ts', (s) => s.replace("import { Item } from './item';", "import { Item } from './item';\nimport { discount } from './discount';"));
  git('commit', '-q', '-am', 'Use discount in the cart');
  git('mv', 'src/legacy.ts', 'src/modern.ts');
  git('commit', '-q', '-m', 'Rename legacy to modern');
  git('checkout', '-q', 'main');
}

// ------------------------------------------------------------------ steps

const steps = [
  {
    title: 'Create a file',
    look: 'A new tab types src/coupons.ts. Every line gets a soft green background, a green gutter bar and a scrollbar mark, from the first characters on.',
    run: () => write('src/coupons.ts', 'export interface Coupon {\n  code: string;\n  percentOff: number;\n}\n\nexport const NONE: Coupon = { code: "", percentOff: 0 };\n'),
  },
  {
    title: 'Change a word, add a function',
    look: 'In cart.ts, "number" becomes "Money" on the count() line: only "Money" gets the stronger green, and a red triangle marks the line. Hover it to see "number". The new function below is plain green lines.',
    run: () =>
      edit('src/cart.ts', (s) =>
        s.replace('export function count(items: Item[]): number {', 'export function count(items: Item[]): Money {') +
        '\nexport type Money = number;\n\nexport function isEmpty(items: Item[]): boolean {\n  return items.length === 0;\n}\n'),
  },
  {
    title: 'Backspace short words',
    look: 'Each "amount" in subtotal() turns red with a strikethrough while it is backspaced, then "total" is typed. The caret walks between nearby edits with arrow keys.',
    run: () => edit('src/cart.ts', (s) => s.replaceAll('amount', 'total')),
  },
  {
    title: 'Delete a block',
    look: 'In long.ts, six lines are selected and shown red before they go. A red triangle stays where they were; hover it for the six removed lines.',
    run: () => edit('src/long.ts', (s) => s.split('\n').filter((_, i) => i < 20 || i >= 26).join('\n')),
  },
  {
    title: 'Remove a big block',
    look: 'Thirty lines go at once. The hover on the new triangle shows 20 lines and then "... 10 more lines removed".',
    run: () => edit('src/long.ts', (s) => s.split('\n').filter((_, i) => i < 60 || i >= 90).join('\n')),
  },
  {
    title: 'Edits far apart',
    look: 'Two edits near the top and bottom of long.ts: after the first, the view pauses, then scrolls smoothly down to the second.',
    run: () =>
      edit('src/long.ts', (s) => s.replace('export const value3 = 9;', 'export const value3 = 900;').replace('export const value130 = 390;', 'export const value130 = 39000;')),
  },
  {
    title: 'Flip between files',
    look: 'cart.ts, notes.md, then cart.ts again, each typed in its own tab, in that order. Every file keeps its earlier highlights.',
    run: async () => {
      edit('src/cart.ts', (s) => s + '\nexport const CURRENCY = "USD";\n');
      await sleep(500);
      edit('docs/notes.md', (s) => s + '- Currency is USD for now.\n');
      await sleep(500);
      edit('src/cart.ts', (s) => s + 'export const LOCALE = "en-US";\n');
    },
  },
  {
    title: 'Add a line, then take it back',
    look: 'notes.md gets a line that a second change removes again. Once both have played, that line leaves no green and no triangle: highlights are a net diff.',
    run: async () => {
      edit('docs/notes.md', (s) => s + '- TODO: maybe support gift cards?\n');
      await sleep(700);
      edit('docs/notes.md', (s) => s.replace('- TODO: maybe support gift cards?\n', ''));
    },
  },
  {
    title: 'A burst of changes',
    look: 'Eight changes across three files in under four seconds. The queue grows in the status bar and Playback panel, and typing speeds up to catch up.',
    run: async () => {
      for (let i = 1; i <= 8; i++) {
        const rel = ['src/coupons.ts', 'src/cart.ts', 'docs/notes.md'][i % 3];
        edit(rel, (s) => s + (rel.endsWith('.md') ? `- Burst note ${i}.\n` : `export const burst${i} = ${i};\n`));
        await sleep(450);
      }
    },
  },
  {
    title: 'A big paste',
    look: 'src/generated.ts gets about 8,000 characters at once, more than maxAnimatedChars, so it appears instantly instead of being typed. Only the new lines are green.',
    run: () => write('src/generated.ts', '// Generated.\n' + lines(160, (i) => `export const generated${i} = "${'x'.repeat(30)}";\n`)),
  },
  {
    title: 'A CRLF file',
    look: 'crlf.ts is edited and keeps its CRLF line endings (status bar shows CRLF). Highlights land on the right lines.',
    run: () => edit('src/crlf.ts', (s) => s.replace('"bye"', '"goodbye"') + 'export const wave = "o/";\r\n'),
  },
  {
    title: 'Rename a file',
    look: 'legacy.ts is renamed to renamed.ts and then edited. The old tab closes, the new one opens, and the edit is highlighted there.',
    run: async () => {
      fs.renameSync(path.join(repo, 'src/legacy.ts'), path.join(repo, 'src/renamed.ts'));
      await sleep(1500);
      edit('src/renamed.ts', (s) => s.replace('"old"', '"renamed"'));
    },
  },
  {
    title: 'Delete a file',
    look: 'doomed.ts is selected whole and shown red, then emptied. The empty mirror keeps one red triangle at line 1; hover it for the deleted text.',
    run: () => fs.rmSync(path.join(repo, 'src/doomed.ts')),
  },
];

const checklist = `
Things to try by hand now (Explorer > Playback, and the replay editor):

  [ ] Drag the Playback slider back a few changes and release: highlights of
      changes not yet replayed disappear, and come back as they replay.
  [ ] Pause, then press Skip to Latest: everything that jumped in is highlighted.
  [ ] On the replay editor's title bar, press Clear Highlights in This File:
      that file clears, others keep theirs. The button only shows on the tab
      being played into, and only while it has highlights.
  [ ] Press Clear Highlights in the Playback panel: every file clears and the
      button greys out. Edit a file in a terminal: only the new edit is green.
  [ ] Press Replay from the start: the cleared highlights come back as it replays.
  [ ] Settings: turn agentTypewriter.highlightAdditions off (brief flash
      instead of green), then agentTypewriter.markDeletions off (no red, no
      triangles). Turn both back on: highlights reappear.
  [ ] Switch themes (Preferences: Color Theme): a dark, a light, and a high
      contrast theme. Colors stay soft; gutter icons stay visible.
  [ ] Developer: Reload Window: the timeline, the playback position and any
      clear come back; reopened tabs show the same highlights.
  [ ] Agent Typewriter: Save Session to File..., then Load Session from File...:
      the session starts paused with no highlights and replays from the start.
  [ ] Agent Typewriter: Replay Git Commits..., range main..feature: three commits
      replay (a new file, an edit, a rename) without touching the repository.
  [ ] Close a mirror tab mid-typing: it reopens and typing carries on.

The repository stays at ${repo} for more experiments; delete it when done.
`;

// ------------------------------------------------------------------ run

function launch() {
  const r = spawnSync('npm', ['run', 'build'], { cwd: root, stdio: 'inherit' });
  if (r.status !== 0) throw new Error('npm run build failed');
  // A VS Code terminal hands its children IPC variables that would send the
  // launch to the parent window instead of a new instance.
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('VSCODE_') && k !== 'ELECTRON_RUN_AS_NODE'));
  const userData = path.join(tmp(), 'user-data');
  fs.mkdirSync(path.join(userData, 'User'), { recursive: true });
  fs.writeFileSync(path.join(userData, 'User/settings.json'), JSON.stringify({
    'workbench.startupEditor': 'none',
    'security.workspace.trust.enabled': false,
    'telemetry.telemetryLevel': 'off',
    'update.mode': 'none',
    'chat.disableAIFeatures': true,
  }, null, 2));
  return import('@vscode/test-electron').then(async ({ downloadAndUnzipVSCode }) => {
    const exe = await downloadAndUnzipVSCode({ version: 'stable', cachePath: path.join(root, '.vscode-test') });
    spawn(exe, [
      '--extensionDevelopmentPath', root,
      '--user-data-dir', userData,
      '--extensions-dir', path.join(tmp(), 'extensions'),
      '--disable-extensions',
      '--skip-welcome',
      '--skip-release-notes',
      '--new-window',
      repo,
    ], { env, stdio: 'ignore', detached: true }).unref();
  });
}

makeRepo();
console.log(`Tour repository: ${repo}`);
if (!opts['no-launch']) await launch();

const rl = opts.auto ? undefined : readline.createInterface({ input: process.stdin, output: process.stdout });
let auto = opts.auto;
if (rl) {
  console.log('\nWait for the VS Code window to open and show "Watching" in the status bar.');
  console.log('Open Explorer > Playback to follow along. Before each step, press Enter; type "a" to run the rest without stopping, "q" to stop.');
} else {
  await sleep(opts['no-launch'] ? 0 : 12000);
}

for (const [i, step] of steps.entries()) {
  console.log(`\n${i + 1}/${steps.length}  ${step.title}\n     Watch: ${step.look}`);
  if (rl && !auto) {
    const answer = (await rl.question('     Enter to run > ')).trim().toLowerCase();
    if (answer === 'q') break;
    if (answer === 'a') auto = true;
  }
  await step.run();
  console.log('     Done.');
  if (auto && i < steps.length - 1) await sleep(Number(opts.delay));
}
rl?.close();
console.log(checklist);
