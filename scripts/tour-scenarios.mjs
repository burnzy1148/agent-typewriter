// The scenarios shared by replay-tour.mjs and demo/record.mjs: the starting
// files of a small git repository and the agent steps that edit it, each
// saying what replay should show. The last steps add two git worktrees and
// play two agents working in them at once, each recorded in its own lane.
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const gitIn = (repo) => (...args) =>
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

// File helpers relative to repo; each step's run receives one as `ws`.
export function workspace(repo) {
  const write = (rel, text) => {
    fs.mkdirSync(path.dirname(path.join(repo, rel)), { recursive: true });
    fs.writeFileSync(path.join(repo, rel), text);
  };
  const read = (rel) => fs.readFileSync(path.join(repo, rel), 'utf8');
  return {
    write,
    read,
    edit: (rel, fn) => write(rel, fn(read(rel))),
    rename: (from, to) => fs.renameSync(path.join(repo, from), path.join(repo, to)),
    remove: (rel) => fs.rmSync(path.join(repo, rel)),
    git: gitIn(repo),
  };
}

// Makes the repository, with a feature branch for Replay Git Commits. Settings
// are merged into its .vscode/settings.json. Worktrees the lane steps add get
// their own lanes (autoRecordWorktrees), and playback moves on to the next
// lane once the followed one is caught up (autoFollow).
export function makeRepo(repo, settings = {}) {
  const git = gitIn(repo);
  const { write, edit } = workspace(repo);
  if (fs.existsSync(repo)) throw new Error(`${repo} already exists`);
  fs.mkdirSync(repo, { recursive: true });
  git('init', '-q', '-b', 'main');
  for (const [rel, text] of Object.entries(files)) write(rel, text);
  write('.vscode/settings.json', JSON.stringify({
    'agentTypewriter.autoStart': true,
    'agentTypewriter.extensions': ['ts', 'md'],
    'agentTypewriter.persistHistory': true,
    'agentTypewriter.autoRecordWorktrees': 'fill',
    'agentTypewriter.autoFollow': true,
    ...settings,
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

// Where the lane steps' two agents work: worktrees on branches of the same name.
const COUPONS = '.claude/worktrees/coupons';
const TAX = '.claude/worktrees/tax';

export const steps = [
  {
    id: 'create-file',
    title: 'Create a file',
    look: 'A new tab types src/coupons.ts. Every line gets a soft green background, a green gutter bar and a scrollbar mark, from the first characters on.',
    run: (ws) => ws.write('src/coupons.ts', 'export interface Coupon {\n  code: string;\n  percentOff: number;\n}\n\nexport const NONE: Coupon = { code: "", percentOff: 0 };\n'),
  },
  {
    id: 'change-word',
    title: 'Change a word, add a function',
    look: 'In cart.ts, "number" becomes "Money" on the count() line: only "Money" gets the stronger green, and a red triangle marks the line. Hover it to see "number". The new function below is plain green lines.',
    run: (ws) =>
      ws.edit('src/cart.ts', (s) =>
        s.replace('export function count(items: Item[]): number {', 'export function count(items: Item[]): Money {') +
        '\nexport type Money = number;\n\nexport function isEmpty(items: Item[]): boolean {\n  return items.length === 0;\n}\n'),
  },
  {
    id: 'backspace-words',
    title: 'Backspace short words',
    look: 'Each "amount" in subtotal() turns red with a strikethrough while it is backspaced, then "total" is typed. The caret walks between nearby edits with arrow keys.',
    run: (ws) => ws.edit('src/cart.ts', (s) => s.replaceAll('amount', 'total')),
  },
  {
    id: 'delete-block',
    title: 'Delete a block',
    look: 'In long.ts, six lines are selected and shown red before they go. A red triangle stays where they were; hover it for the six removed lines.',
    run: (ws) => ws.edit('src/long.ts', (s) => s.split('\n').filter((_, i) => i < 20 || i >= 26).join('\n')),
  },
  {
    id: 'remove-big-block',
    title: 'Remove a big block',
    look: 'Thirty lines go at once. The hover on the new triangle shows 20 lines and then "... 10 more lines removed".',
    run: (ws) => ws.edit('src/long.ts', (s) => s.split('\n').filter((_, i) => i < 60 || i >= 90).join('\n')),
  },
  {
    id: 'edits-far-apart',
    title: 'Edits far apart',
    look: 'Two edits near the top and bottom of long.ts: after the first, the view pauses, then scrolls smoothly down to the second.',
    run: (ws) =>
      ws.edit('src/long.ts', (s) => s.replace('export const value3 = 9;', 'export const value3 = 900;').replace('export const value130 = 390;', 'export const value130 = 39000;')),
  },
  {
    id: 'flip-files',
    title: 'Flip between files',
    look: 'cart.ts, notes.md, then cart.ts again, each typed in its own tab, in that order. Every file keeps its earlier highlights.',
    run: async (ws) => {
      ws.edit('src/cart.ts', (s) => s + '\nexport const CURRENCY = "USD";\n');
      await sleep(500);
      ws.edit('docs/notes.md', (s) => s + '- Currency is USD for now.\n');
      await sleep(500);
      ws.edit('src/cart.ts', (s) => s + 'export const LOCALE = "en-US";\n');
    },
  },
  {
    id: 'add-then-take-back',
    title: 'Add a line, then take it back',
    look: 'notes.md gets a line that a second change removes again. Once both have played, that line leaves no green and no triangle: highlights are a net diff.',
    run: async (ws) => {
      ws.edit('docs/notes.md', (s) => s + '- TODO: maybe support gift cards?\n');
      await sleep(700);
      ws.edit('docs/notes.md', (s) => s.replace('- TODO: maybe support gift cards?\n', ''));
    },
  },
  {
    id: 'burst',
    title: 'A burst of changes',
    look: 'Eight changes across three files in under four seconds. The queue grows in the status bar and Playback panel, and typing speeds up to catch up.',
    run: async (ws) => {
      for (let i = 1; i <= 8; i++) {
        const rel = ['src/coupons.ts', 'src/cart.ts', 'docs/notes.md'][i % 3];
        ws.edit(rel, (s) => s + (rel.endsWith('.md') ? `- Burst note ${i}.\n` : `export const burst${i} = ${i};\n`));
        await sleep(450);
      }
    },
  },
  {
    id: 'big-paste',
    title: 'A big paste',
    look: 'src/generated.ts gets about 8,000 characters at once, more than maxAnimatedChars, so it appears instantly instead of being typed. Only the new lines are green.',
    run: (ws) => ws.write('src/generated.ts', '// Generated.\n' + lines(160, (i) => `export const generated${i} = "${'x'.repeat(30)}";\n`)),
  },
  {
    id: 'crlf',
    title: 'A CRLF file',
    look: 'crlf.ts is edited and keeps its CRLF line endings (status bar shows CRLF). Highlights land on the right lines.',
    run: (ws) => ws.edit('src/crlf.ts', (s) => s.replace('"bye"', '"goodbye"') + 'export const wave = "o/";\r\n'),
  },
  {
    id: 'rename-file',
    title: 'Rename a file',
    look: 'legacy.ts is renamed to renamed.ts and then edited. The old tab closes, the new one opens, and the edit is highlighted there.',
    run: async (ws) => {
      ws.rename('src/legacy.ts', 'src/renamed.ts');
      await sleep(1500);
      ws.edit('src/renamed.ts', (s) => s.replace('"old"', '"renamed"'));
    },
  },
  {
    id: 'delete-file',
    title: 'Delete a file',
    look: 'doomed.ts is selected whole and shown red, then emptied. The empty mirror keeps one red triangle at line 1; hover it for the deleted text.',
    run: (ws) => ws.remove('src/doomed.ts'),
  },
  {
    id: 'add-worktrees',
    title: 'Two agents get their own checkouts',
    look: 'Two git worktrees appear under .claude/worktrees, on branches coupons and tax. In the Checkouts view (Agent Typewriter in the Activity Bar), each is ticked within a few seconds and gets its own lane color: main blue, coupons green, tax orange. The eye stays on main.',
    run: (ws) => {
      ws.git('worktree', 'add', '-q', '-b', 'coupons', COUPONS);
      ws.git('worktree', 'add', '-q', '-b', 'tax', TAX);
    },
  },
  {
    id: 'two-agents',
    title: 'Two agents at once',
    look: 'The coupons and tax agents edit their own worktrees, taking turns. Each change queues in its checkout\'s lane. Auto-follow moves the eye to coupons and types its changes in green-tinted tabs while tax\'s queue grows in the Checkouts view. Once coupons is caught up and quiet for 3 seconds, playback follows tax, in orange-tinted tabs. Each lane has its own cart.ts tab.',
    run: async (ws) => {
      ws.write(`${COUPONS}/src/coupons.ts`, 'export interface Coupon {\n  code: string;\n  percentOff: number;\n}\n');
      await sleep(600);
      ws.edit(`${TAX}/src/cart.ts`, (s) => s + '\nexport const TAX_RATE = 0.08;\n');
      await sleep(600);
      ws.edit(`${COUPONS}/src/cart.ts`, (s) => s + '\nexport function applyCoupon(amount: number, percentOff: number): number {\n  return amount * (1 - percentOff / 100);\n}\n');
      await sleep(600);
      ws.edit(`${TAX}/src/cart.ts`, (s) => s + '\nexport function withTax(amount: number): number {\n  return amount * (1 + TAX_RATE);\n}\n');
      await sleep(600);
      ws.edit(`${TAX}/docs/notes.md`, (s) => s + '- Tax is 8% for now.\n');
    },
  },
];
