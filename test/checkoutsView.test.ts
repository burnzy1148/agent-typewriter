import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { CheckoutRow, CheckoutsView, FOLLOWED_SCHEME, followedRowUri, followingHeader, FolderNode, LaneRow, OthersNode, pathInside, type FolderCheckoutsModel } from '../src/checkoutsView';
import { LaneDecorations } from '../src/laneDecorations';
import { Timeline } from '../src/timeline';
import { laneKey } from '../src/worktrees';

const folder = (name: string) => ({ uri: vscode.Uri.file(`/w/${name}`), name, index: 0 }) as unknown as vscode.WorkspaceFolder;

function model(f: vscode.WorkspaceFolder, recorded: string[]): FolderCheckoutsModel {
  return {
    folder: f,
    checkouts: [
      { path: f.uri.fsPath, name: 'main', own: true },
      { path: `${f.uri.fsPath}/.claude/worktrees/feat`, name: 'feat', own: false },
      { path: `${f.uri.fsPath}-side`, name: 'side', own: false },
    ],
    recorded,
  };
}

function viewOf(t: Timeline, models: FolderCheckoutsModel[], add = async () => {}) {
  const errors: string[] = [];
  let current = models;
  const view = new CheckoutsView(t, async () => current, {
    add: async (f, p) => {
      await add();
      current = current.map((m) => (m.folder === f ? { ...m, recorded: [...m.recorded, p] } : m));
    },
    remove: async (f, p) => {
      current = current.map((m) => (m.folder === f ? { ...m, recorded: m.recorded.filter((r) => r !== p) } : m));
    },
    error: (m) => errors.push(m),
  });
  return { view, errors };
}

test('a row per checkout, ticked when recorded, with its lane once it has one', async () => {
  const f = folder('repo');
  const t = new Timeline(100);
  const mainLane = laneKey(f.uri.toString(), true, f.uri.fsPath);
  t.defineLane({ id: mainLane, label: 'main', root: f.uri.fsPath, color: 1, recording: true });
  t.push({ uri: 'file:///w/repo/a.ts', relPath: 'a.ts', time: 1, kind: 'modify', before: 'a', after: 'b', eol: '\n', linesAdded: 1, linesRemoved: 1, lane: mainLane });
  const { view } = viewOf(t, [model(f, [f.uri.fsPath])]);
  await view.reload();
  const rows = view.getChildren() as CheckoutRow[];
  assert.deepEqual(rows.map((r) => [r.label, r.checkboxState]), [
    ['main', vscode.TreeItemCheckboxState.Checked],
    ['feat', vscode.TreeItemCheckboxState.Unchecked],
    ['side', vscode.TreeItemCheckboxState.Unchecked],
  ]);
  // The only lane is marked as followed too.
  assert.equal(rows[0].description, 'this folder  ·  1 queued');
  assert.equal(rows[0].resourceUri?.scheme, FOLLOWED_SCHEME);
  assert.equal((rows[0].iconPath as vscode.ThemeIcon).id, 'eye');
  assert.equal(rows[1].description, '.claude/worktrees/feat');
  assert.equal(rows[0].contextValue, 'lane.followed');
  assert.equal(rows[1].contextValue, 'checkout');
  view.dispose();
});

test('ticking records the checkout; a refused tick reports why and leaves the box clear', async () => {
  const f = folder('repo');
  const t = new Timeline(100);
  let refuse = true;
  const { view, errors } = viewOf(t, [model(f, [f.uri.fsPath])], async () => {
    if (refuse) throw new Error('At most 5 checkouts record at once.');
  });
  await view.reload();
  const side = () => (view.getChildren() as CheckoutRow[])[2];
  await view.setChecked(side(), true);
  assert.deepEqual(errors, ['At most 5 checkouts record at once.']);
  assert.equal(side().checkboxState, vscode.TreeItemCheckboxState.Unchecked);
  refuse = false;
  await view.setChecked(side(), true);
  assert.equal(side().checkboxState, vscode.TreeItemCheckboxState.Checked);
  view.dispose();
});

test('folders get nodes in multi-root, and lanes no checkout lists are listed apart', async () => {
  const a = folder('a');
  const b = folder('b');
  const t = new Timeline(100);
  t.defineLane({ id: 'gone', label: 'old-branch', root: '/w/old', color: 3, recording: false });
  t.push({ uri: 'file:///w/old/x.ts', relPath: 'old/x.ts', time: 1, kind: 'modify', before: 'a', after: 'b', eol: '\n', linesAdded: 1, linesRemoved: 1, lane: 'gone' });
  const { view } = viewOf(t, [model(a, [a.uri.fsPath]), model(b, [b.uri.fsPath])]);
  await view.reload();
  const top = view.getChildren();
  assert.deepEqual(top.map((n) => n.constructor.name), [FolderNode.name, FolderNode.name, OthersNode.name]);
  const others = view.getChildren(top[2]) as LaneRow[];
  assert.deepEqual(others.map((r) => [r.label, r.description]), [['old-branch', '1 queued']]);
  assert.equal((others[0].iconPath as vscode.ThemeIcon).id, 'eye', 'the only lane is marked as followed');
  assert.equal(view.getChildren(top[0]).length, 3);
  view.dispose();
});

test('with two lanes the followed row has an eye, a decoration and says what it is doing; the header names it', async () => {
  const f = folder('repo');
  const t = new Timeline(100);
  const mainLane = laneKey(f.uri.toString(), true, f.uri.fsPath);
  const featLane = laneKey(f.uri.toString(), false, `${f.uri.fsPath}/.claude/worktrees/feat`);
  t.defineLane({ id: mainLane, label: 'main', root: f.uri.fsPath, color: 1, recording: true });
  t.defineLane({ id: featLane, label: 'feat', root: '/w/feat', color: 2, recording: true });
  const change = (lane: string) => t.push({ uri: 'file:///w/x.ts', relPath: lane === mainLane ? 'x.ts' : 'feat/x.ts', time: 1, kind: 'modify', before: 'a', after: 'b', eol: '\n', linesAdded: 1, linesRemoved: 1, lane });
  const f1 = change(featLane);
  change(featLane);
  t.follow(featLane);
  const { view } = viewOf(t, [model(f, [f.uri.fsPath, `${f.uri.fsPath}/.claude/worktrees/feat`])]);
  await view.reload();
  const rows = () => view.getChildren() as CheckoutRow[];
  const feat = () => rows()[1];
  assert.equal((feat().iconPath as vscode.ThemeIcon).id, 'eye');
  assert.equal(((feat().iconPath as vscode.ThemeIcon).color as unknown as { id: string }).id, 'agentTypewriter.lane2');
  assert.equal(feat().resourceUri?.scheme, FOLLOWED_SCHEME);
  assert.equal(feat().description, '.claude/worktrees/feat  ·  2 queued');
  assert.equal(rows()[0].resourceUri, undefined, 'only the followed row is marked');
  assert.equal((rows()[0].iconPath as vscode.ThemeIcon).id, 'circle-filled');
  t.begin(f1.seq);
  assert.equal(feat().description, '.claude/worktrees/feat  ·  typing');
  t.complete(f1.seq);
  t.seekToEnd();
  assert.equal(feat().description, '.claude/worktrees/feat  ·  caught up');
  assert.equal(followingHeader(t), 'Following: feat');
  // The decoration tints and badges the followed row, and nothing once another lane is followed.
  const decorations = new LaneDecorations(t);
  const mark = decorations.provideFileDecoration(followedRowUri(featLane));
  assert.equal(mark?.badge, '\u25B6');
  assert.equal((mark?.color as unknown as { id: string }).id, 'agentTypewriter.lane2');
  t.follow(mainLane);
  assert.equal(decorations.provideFileDecoration(followedRowUri(featLane)), undefined);
  assert.equal(followingHeader(t), 'Following: main');
  decorations.dispose();
  view.dispose();
});

test('with one lane the header names it; with none there is no header', () => {
  const t = new Timeline(100);
  assert.equal(followingHeader(t), undefined);
  t.defineLane({ id: 'only', label: 'main', root: '/w', color: 1, recording: true });
  assert.equal(followingHeader(t), 'Following: main');
});

test('pathInside: strictly inside only, with forward slashes', () => {
  const P = (...parts: string[]) => path.resolve('/', ...parts);
  assert.equal(pathInside(P('repo'), P('repo', '.claude', 'worktrees', 'feat')), '.claude/worktrees/feat');
  assert.equal(pathInside(P('repo'), P('repo')), undefined);
  assert.equal(pathInside(P('repo'), P('repo-side')), undefined);
  assert.equal(pathInside(P('repo', 'a'), P('repo')), undefined);
  assert.equal(pathInside(P('repo'), P('repo', '..dots')), '..dots', 'a name starting with two dots is still inside');
});

// --- at-dd6: a workspace folder opened through a symlink, worktrees listed by their real paths.

test('at-dd6 a folder opened through a symlink shows a nested worktree relative to it', async (ctx) => {
  const real = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'at-cv-real-')));
  fs.mkdirSync(path.join(real, '.claude', 'worktrees', 'coupons'), { recursive: true });
  const link = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'at-cv-link-')), 'repo');
  try {
    fs.symlinkSync(real, link, process.platform === 'win32' ? 'junction' : 'dir');
  } catch {
    return ctx.skip('cannot create a symlink here');
  }
  const f = { uri: vscode.Uri.file(link), name: 'repo', index: 0 } as unknown as vscode.WorkspaceFolder;
  // Git reports every worktree by its real path.
  const m: FolderCheckoutsModel = {
    folder: f,
    checkouts: [
      { path: real, name: 'main', own: true },
      { path: path.join(real, '.claude', 'worktrees', 'coupons'), name: 'coupons', own: false },
      { path: `${real}-side`, name: 'side', own: false },
    ],
    // Recorded as spelled through the link: still the same checkout.
    recorded: [real, path.join(link, '.claude', 'worktrees', 'coupons')],
  };
  const t = new Timeline(100);
  const { view } = viewOf(t, [m]);
  await view.reload();
  // Redraws use what the reload read: nothing is resolved on disk again.
  const realpathSync = fs.realpathSync.native;
  fs.realpathSync.native = (() => {
    throw new Error('a redraw resolved a path');
  }) as unknown as typeof fs.realpathSync.native;
  try {
    const rows = view.getChildren() as CheckoutRow[];
    assert.deepEqual(
      rows.map((r) => [r.description, r.checkboxState]),
      [
        ['this folder', vscode.TreeItemCheckboxState.Checked],
        ['.claude/worktrees/coupons', vscode.TreeItemCheckboxState.Checked],
        [`${real}-side`, vscode.TreeItemCheckboxState.Unchecked],
      ],
    );
    assert.equal(rows[1].lane, laneKey(f.uri.toString(), false, path.join(real, '.claude', 'worktrees', 'coupons')));
  } finally {
    fs.realpathSync.native = realpathSync;
  }
  view.dispose();
});
