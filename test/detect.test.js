'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  detectBom,
  detectLineEndings,
  hasFinalNewline,
  isBinary,
  firstNulOffset,
  analyzeBuffer,
} = require('../src/detect.js');

const hex = (s) => Buffer.from(s, 'utf8').toString('hex');

test('detectBom: UTF-8 BOM found on raw bytes', () => {
  const buf = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('hello')]);
  const bom = detectBom(buf);
  assert.equal(bom.encoding, 'utf8');
  assert.equal(bom.length, 3);
});

test('detectBom: no BOM returns null', () => {
  const bom = detectBom(Buffer.from('plain text\n'));
  assert.equal(bom.encoding, null);
  assert.equal(bom.length, 0);
});

test('detectBom: UTF-16LE BOM distinguished from UTF-8', () => {
  const buf = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from([0x68, 0x00])]);
  const bom = detectBom(buf);
  assert.equal(bom.encoding, 'utf16le');
  assert.equal(bom.length, 2);
});

test('detectBom: UTF-16BE BOM detected', () => {
  const buf = Buffer.concat([Buffer.from([0xfe, 0xff]), Buffer.from([0x00, 0x68])]);
  assert.equal(detectBom(buf).encoding, 'utf16be');
});

test('detectBom: a lone 0xEF byte is not a BOM', () => {
  assert.equal(detectBom(Buffer.from([0xef, 0x61, 0x62])).encoding, null);
});

test('detectLineEndings: counts CRLF', () => {
  const r = detectLineEndings('a\r\nb\r\nc\r\n');
  assert.equal(r.crlf, 3);
  assert.equal(r.lf, 0);
  assert.equal(r.cr, 0);
  assert.equal(r.dominant, 'crlf');
});

test('detectLineEndings: counts bare LF without miscounting CRLF', () => {
  const r = detectLineEndings('a\nb\n');
  assert.equal(r.lf, 2);
  assert.equal(r.crlf, 0);
  assert.equal(r.dominant, 'lf');
});

test('detectLineEndings: counts bare CR', () => {
  const r = detectLineEndings('a\rb\r');
  assert.equal(r.cr, 2);
  assert.equal(r.crlf, 0);
  assert.equal(r.dominant, 'cr');
});

test('detectLineEndings: mixed terminators reported as mixed', () => {
  const r = detectLineEndings('a\r\nb\nc\rd');
  assert.equal(r.dominant, 'mixed');
  assert.deepEqual([r.crlf, r.lf, r.cr], [1, 1, 1]);
});

test('detectLineEndings: text with no terminators is "none"', () => {
  const r = detectLineEndings('single line, no newline');
  assert.equal(r.dominant, 'none');
  assert.equal(r.total, 0);
});

test('detectLineEndings: start offset skips the BOM bytes', () => {
  const buf = Buffer.from('\uFEFFa\nb\n', 'utf8');
  // 0x0A does not appear in a BOM, but asserting the offset contract catches a
  // future change that starts decoding at the wrong place.
  const withOffset = detectLineEndings(buf, 3);
  assert.equal(withOffset.lf, 2);
});

test('detectLineEndings: empty input is none, not a crash', () => {
  assert.equal(detectLineEndings('').dominant, 'none');
  assert.equal(detectLineEndings(Buffer.alloc(0)).total, 0);
});

test('hasFinalNewline: true for LF and CR, false without', () => {
  assert.equal(hasFinalNewline('a\n'), true);
  assert.equal(hasFinalNewline('a\r\n'), true);
  assert.equal(hasFinalNewline('a\r'), true);
  assert.equal(hasFinalNewline('a'), false);
  assert.equal(hasFinalNewline(''), false);
});

test('isBinary: a NUL byte marks the file as binary', () => {
  assert.equal(isBinary(Buffer.from('abc\u0000def')), true);
});

test('isBinary: ordinary text is not binary', () => {
  assert.equal(isBinary(Buffer.from('just text\n')), false);
});

test('isBinary: an empty file is not binary', () => {
  assert.equal(isBinary(Buffer.alloc(0)), false);
});

test('firstNulOffset: reports the byte index', () => {
  assert.equal(firstNulOffset(Buffer.from('abc\u0000')), 3);
  assert.equal(firstNulOffset(Buffer.from('abc')), -1);
});

test('analyzeBuffer: reports BOM, terminators, size and support together', () => {
  const buf = Buffer.from('\uFEFFa  \r\nb\r\n', 'utf8');
  const a = analyzeBuffer(buf);
  assert.equal(a.bom.encoding, 'utf8');
  assert.equal(a.lineEndings.dominant, 'crlf');
  assert.equal(a.finalNewline, true);
  assert.equal(a.binary, false);
  assert.equal(a.supported, true);
  assert.equal(a.size, buf.length);
  assert.equal(a.reason, null);
});

test('analyzeBuffer: UTF-16 is unsupported and carries a clear reason', () => {
  const buf = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from([0x68, 0x00, 0x0a, 0x00])]);
  const a = analyzeBuffer(buf);
  assert.equal(a.supported, false);
  assert.match(a.reason, /UTF-16LE BOM/);
  assert.match(a.reason, /UTF-8/);
});

test('analyzeBuffer: reports a missing final newline', () => {
  assert.equal(analyzeBuffer(Buffer.from('a\nb')).finalNewline, false);
});

test('analyzeBuffer: a BOM-only file is still classified correctly', () => {
  const a = analyzeBuffer(Buffer.from([0xef, 0xbb, 0xbf]));
  assert.equal(a.bom.encoding, 'utf8');
  assert.equal(a.lineEndings.total, 0);
  assert.equal(hex(Buffer.from('\uFEFF', 'utf8')), 'efbbbf');
});
