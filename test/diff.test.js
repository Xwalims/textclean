'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { unifiedDiff, toLines } = require('../src/diff.js');

test('identical texts produce no diff', () => {
  assert.equal(unifiedDiff('a\nb\n', 'a\nb\n', 'f.txt'), '');
});

test('the ---/+++ headers carry the file label', () => {
  const d = unifiedDiff('a  \n', 'a\n', 'src/f.txt');
  assert.ok(d.startsWith('--- a/src/f.txt\n+++ b/src/f.txt\n'));
});

test('a trailing-space removal is shown as a -/+ pair', () => {
  const d = unifiedDiff('a  \n', 'a\n', 'f.txt');
  assert.ok(d.includes('-a  '), 'the old line keeps its spaces');
  assert.ok(d.includes('+a'), 'the new line has none');
});

test('a CRLF to LF change is visible rather than silent', () => {
  const d = unifiedDiff('a\r\nb\r\n', 'a\nb\n', 'f.txt');
  // A CR is rendered as a literal escape so the difference can be seen.
  assert.ok(d.includes('\\r\\n'), 'the CRLF is shown explicitly');
});

test('a missing final newline is marked explicitly', () => {
  const d = unifiedDiff('a\nb\n', 'a\nb', 'f.txt');
  assert.ok(d.includes('(no newline at end of file)'));
});

test('hunk headers use the @@ -a,b +c,d @@ form', () => {
  const d = unifiedDiff('a\nb\nc\n', 'a\nb\n', 'f.txt');
  assert.match(d, /@@ -\d+,\d+ \+\d+,\d+ @@/);
});

test('hunk header numbers match the real positions', () => {
  // Lines 1-6; only line 3 changes.
  const before = 'l1\nl2\nl3  \nl4\nl5\nl6\n';
  const after = 'l1\nl2\nl3\nl4\nl5\nl6\n';
  const d = unifiedDiff(before, after, 'f.txt', { context: 1 });
  assert.match(d, /@@ -2,3 \+2,3 @@/);
});

test('unchanged context lines are included around the change', () => {
  const d = unifiedDiff('a\nb\nc  \nd\ne\n', 'a\nb\nc\nd\ne\n', 'f.txt', { context: 2 });
  assert.ok(d.includes(' b'));
  assert.ok(d.includes(' d'));
});

test('distant changes produce two hunks, not one huge one', () => {
  const lines = Array.from({ length: 40 }, (_, i) => `line ${i}`);
  const before = `${lines.join('\n')}\n`;
  const after = before.replace('line 2', 'line 2  ').replace('line 35', 'line 35  ');
  const d = unifiedDiff(before, after, 'f.txt');
  const hunks = (d.match(/^@@ /gm) || []).length;
  assert.equal(hunks, 2);
  // The '-' line is the BEFORE text, the '+' line is the space-padded AFTER.
  assert.ok(d.includes('-line 2\n'));
  assert.ok(d.includes('+line 2  \n'));
  assert.ok(d.includes('-line 35\n'));
  assert.ok(d.includes('+line 35  \n'));
});

test('a trailing-space difference on one line is a single-line change', () => {
  const d = unifiedDiff('a\nb  \nc\n', 'a\nb\nc\n', 'f.txt', { context: 0 });
  assert.match(d, /@@ -2,1 \+2,1 @@/);
});

test('lines that only differ by terminator are reported as one change', () => {
  const d = unifiedDiff('a\r\nb\r\n', 'a\nb\n', 'f.txt', { context: 0 });
  assert.equal((d.match(/^@@ /gm) || []).length, 1);
});

test('a blank line becoming a non-blank line is a change', () => {
  const d = unifiedDiff('a\n\nb\n', 'a\n  \nb\n', 'f.txt', { context: 0 });
  assert.ok(d.includes('@@'));
});

test('toLines keeps the terminator alongside each line', () => {
  const lines = toLines('a\r\nb\nc');
  assert.deepEqual(lines.map((l) => l.text), ['a', 'b', 'c']);
  assert.deepEqual(lines.map((l) => l.term), ['\r\n', '\n', '']);
});

test('a multi-line insertion renders every added line', () => {
  const d = unifiedDiff('a\n', 'a\nb\nc\n', 'f.txt', { context: 0 });
  assert.ok(d.includes('+b'));
  assert.ok(d.includes('+c'));
});
