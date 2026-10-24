import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as vscode from 'vscode';
import { ChangeItem, LaneItem, TimelineView } from '../src/timelineView';
import { Timeline, type NewChangeEvent } from '../src/timeline';

function ev(relPath: string, lane?: string): NewChangeEvent {
  return { uri: 'file:///w/' + relPath, relPath, time: 1, kind: 'modify', before: 'a', after: 'b', eol: '\n', linesAdded: 1, linesRemoved: 1, ...(lane && { lane }) };
}

const lane = (id: string, color: number, recording = true) => ({ id, label: id, root: '/w/' + id, color, recording });

test('one lane is a flat list, newest first', () => {
  const t = new Timeline(100);
  t.push(ev('a.ts', 'main'));
  t.push(ev('b.ts', 'main'));
  const view = new TimelineView(t);
  const items = view.getChildren();
  assert.ok(items.every((i) => i instanceof ChangeItem));
  assert.deepEqual(items.map((i) => i.label), ['b.ts', 'a.ts']);
  view.dispose();
});

test('two lanes give a node per lane, the followed one first and expanded', () => {
  const t = new Timeline(100);
  t.defineLane(lane('main', 1));
  t.defineLane(lane('feat', 2, false));
  t.push(ev('a.ts', 'main'));
  t.push(ev('feat/a.ts', 'feat'));
  t.push(ev('feat/b.ts', 'feat'));
  t.follow('feat');
  const view = new TimelineView(t);
  const lanes = view.getChildren() as LaneItem[];
  assert.ok(lanes.every((i) => i instanceof LaneItem));
  assert.deepEqual(lanes.map((l) => l.label), ['feat', 'main']);
  assert.equal(lanes[0].collapsibleState, vscode.TreeItemCollapsibleState.Expanded);
  assert.equal(lanes[1].collapsibleState, vscode.TreeItemCollapsibleState.Collapsed);
  assert.equal(lanes[0].description, '2 queued  ·  following  ·  stopped');
  assert.equal(lanes[1].description, '1 queued');
  assert.equal(((lanes[0].iconPath as vscode.ThemeIcon).color as unknown as { id: string }).id, 'agentTypewriter.lane2');
  assert.equal(lanes[0].contextValue, 'lane.followed');
  assert.deepEqual(view.getChildren(lanes[0]).map((i) => i.label), ['b.ts', 'a.ts']);
  view.dispose();
});
