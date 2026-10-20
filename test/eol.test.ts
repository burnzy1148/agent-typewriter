import { test } from 'node:test';
import assert from 'node:assert/strict';
import { detectEol, lfOffsetToLineCol } from '../src/planner';

test('detectEol: all LF', () => {
  assert.equal(detectEol('a\nb\nc\n'), '\n');
});

test('detectEol: all CRLF', () => {
  assert.equal(detectEol('a\r\nb\r\nc\r\n'), '\r\n');
});

test('detectEol: mixed, CRLF majority', () => {
  assert.equal(detectEol('a\r\nb\r\nc\r\nd\ne'), '\r\n');
});

test('detectEol: mixed, LF majority', () => {
  assert.equal(detectEol('a\nb\nc\r\nd'), '\n');
});

test('detectEol: a tie counts as LF', () => {
  assert.equal(detectEol('a\r\nb\nc'), '\n');
});

test('detectEol: no breaks counts as LF', () => {
  assert.equal(detectEol(''), '\n');
  assert.equal(detectEol('single line'), '\n');
});

test('lfOffsetToLineCol: offset 0', () => {
  assert.deepEqual(lfOffsetToLineCol('ab\ncd\n', 0), { line: 0, character: 0 });
});

test('lfOffsetToLineCol: end of a line is before its break', () => {
  assert.deepEqual(lfOffsetToLineCol('ab\ncd\n', 2), { line: 0, character: 2 });
});

test('lfOffsetToLineCol: just after a break is the next line start', () => {
  assert.deepEqual(lfOffsetToLineCol('ab\ncd\n', 3), { line: 1, character: 0 });
});

test('lfOffsetToLineCol: end of text after a trailing break', () => {
  assert.deepEqual(lfOffsetToLineCol('ab\ncd\n', 6), { line: 2, character: 0 });
});

test('lfOffsetToLineCol: end of text without a trailing break', () => {
  assert.deepEqual(lfOffsetToLineCol('ab\ncd', 5), { line: 1, character: 2 });
});

test('lfOffsetToLineCol: out-of-range offsets clamp', () => {
  assert.deepEqual(lfOffsetToLineCol('ab', 99), { line: 0, character: 2 });
  assert.deepEqual(lfOffsetToLineCol('ab', -1), { line: 0, character: 0 });
});
