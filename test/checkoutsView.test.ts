import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as vscode from 'vscode';
import { CheckoutRow, CheckoutsView, FolderNode, LaneRow, OthersNode, type FolderCheckoutsModel } from '../src/checkoutsView';
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
  assert.equal(rows[0].description, 'this folder  ·  1 queued  ·  following');
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
  assert.deepEqual(others.map((r) => [r.label, r.description]), [['old-branch', '1 queued  ·  following']]);
  assert.equal(view.getChildren(top[0]).length, 3);
  view.dispose();
});
