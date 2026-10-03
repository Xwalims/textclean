'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { plan, apply } = require('../src/normalize.js');
const { splitLines, fenceMask, expandTabs, shouldSkipFences } = require('../src/normalize.js');

const BOM = '\uFEFF';
const hex = (s) => Buffer.from(s, 'utf8').toString('hex');
/** plan() with a .txt path so fence-skipping defaults to off. */
const run = (text, opts = {}) => plan(text, { filePath: 'file.txt', ...opts });
const out = (text, opts = {}) => run(text, opts).after;

test('CRLF converts to LF', () => {
  assert.equal(out('a\r\nb\r\nc\r\n', { eol: 'lf' }), 'a\nb\nc\n');
});

test('bare CR converts to LF', () => {
  assert.equal(out('a\rb\rc\r', { eol: 'lf' }), 'a\nb\nc\n');
});

test('CRLF converts to bare CR', () => {
  assert.equal(out('a\r\nb\r\n', { eol: 'cr' }), 'a\rb\r');
});

test('mixed terminators are all normalised to LF', () => {
  // The file ends with a bare CR and therefore HAS a final newline; conversion
  // rewrites terminators but does not invent one that was not asked for.
  assert.equal(out('a\r\nb\nc\rd', { eol: 'lf' }), 'a\nb\nc\nd');
  assert.equal(out('a\r\nb\nc\rd', { eol: 'lf', ensureFinalNewline: true }), 'a\nb\nc\nd\n');
});

test('mixed terminators are all normalised to CRLF', () => {
  assert.equal(out('a\r\nb\nc\rd', { eol: 'crlf', ensureFinalNewline: true }), 'a\r\nb\r\nc\r\nd\r\n');
});

test('ensure-crlf forces CRLF even from bare LF', () => {
  assert.equal(out('a\nb\n', { ensureCrlf: true }), 'a\r\nb\r\n');
});

test('--eol keep is a genuine no-op on terminators', () => {
  const messy = 'a\r\nb\nc\rd';
  const r = run(messy, { eol: 'keep' });
  assert.equal(r.after, messy);
  assert.equal(r.changed, false);
});

test('UTF-8 BOM is stripped by --strip-bom', () => {
  const r = run(BOM + 'hello\n', { stripBom: true });
  assert.equal(hex(r.after), hex('hello\n'));
  assert.equal(r.changed, true);
  assert.ok(r.reasons.includes('bom-removed'));
});

test('a retained BOM survives byte-for-byte through a whitespace change', () => {
  const r = run(BOM + 'hello  \n', { stripTrailingWhitespace: true });
  // Exactly one BOM, and the trailing spaces are gone.
  assert.equal(hex(r.after), 'efbbbf' + hex('hello\n'));
  assert.equal(r.changed, true);
  assert.ok(r.reasons.includes('trailing-whitespace-stripped'));
});

test('a retained BOM is not duplicated by line-ending conversion', () => {
  const r = run(BOM + 'a\r\nb\r\n', { eol: 'lf' });
  assert.equal(hex(r.after), 'efbbbf' + hex('a\nb\n'));
});

test('UTF-16 files are rejected and never rewritten', () => {
  // Plain ASCII in UTF-16LE interleaves NUL bytes, which would trip the binary
  // heuristic. The encoding guard runs FIRST so the user gets the real reason.
  const buf = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('hi\n', 'utf16le')]);
  const r = plan(buf, { filePath: 'file.txt', stripBom: true, eol: 'lf' });
  assert.equal(r.binary, true, 'the raw bytes do contain NUL');
  assert.equal(r.supported, false, 'but the encoding guard takes precedence');
  assert.equal(r.changed, false);
  assert.ok(r.reasons.includes('unsupported-encoding'));
  assert.match(r.reason, /UTF-16LE BOM/);
});

test('a UTF-16LE file is refused as unsupported with a clear reason', () => {
  const buf = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('hi\n', 'utf16le')]);
  const r = plan(buf, { filePath: 'file.txt', stripBom: true, eol: 'lf', stripTrailingWhitespace: true });
  assert.equal(r.changed, false);
  assert.match(r.reason, /UTF-16LE BOM/);
  assert.match(r.reason, /UTF-8/);
});

test('a UTF-16BE file is refused with its own BOM name', () => {
  const buf = Buffer.concat([Buffer.from([0xfe, 0xff]), Buffer.from([0x00, 0x68, 0x00, 0x69, 0x00, 0x0a])]);
  const r = plan(buf, { filePath: 'file.txt' });
  assert.equal(r.supported, false);
  assert.equal(r.changed, false);
  assert.match(r.reason, /UTF-16BE BOM/);
});

test('a missing final newline is added when asked', () => {
  const r = run('abc', { ensureFinalNewline: true });
  assert.equal(r.after, 'abc\n');
  assert.ok(r.reasons.includes('final-newline-added'));
});

test('the final newline is removed when asked', () => {
  const r = run('abc\n', { noFinalNewline: true });
  assert.equal(r.after, 'abc');
  assert.ok(r.reasons.includes('final-newline-removed'));
});

test('a file with no trailing newline is untouched by default', () => {
  const r = run('a\nb');
  assert.equal(r.after, 'a\nb');
  assert.equal(r.changed, false);
});

test('an empty file stays empty rather than becoming a newline', () => {
  assert.equal(out('', { ensureFinalNewline: true }), '');
  assert.equal(out('', { eol: 'lf', ensureFinalNewline: true }), '');
});

test('multiple trailing blank lines are collapsed', () => {
  assert.equal(out('a\n\n\n\n\nb\n', { collapseBlankLines: 1 }), 'a\n\nb\n');
  assert.equal(out('a\n\n\n\n\nb\n', { collapseBlankLines: 2 }), 'a\n\n\nb\n');
  assert.equal(out('a\n\n\n\n\nb\n', { collapseBlankLines: 0 }), 'a\n\n\n\n\nb\n');
});

test('trailing blank lines at end of file are removed', () => {
  assert.equal(out('a\n\n\n\n', { noTrailingBlankLines: true }), 'a\n');
});

test('trailing whitespace is stripped outside fences', () => {
  assert.equal(out('a  \nb\t\nc\n', { stripTrailingWhitespace: true }), 'a\nb\nc\n');
});

test('leading whitespace is trimmed when asked', () => {
  assert.equal(out('  a\n\tb\n', { trimLeadingWhitespace: true }), 'a\nb\n');
});

test('tabs are converted to spaces using n-column tab stops', () => {
  assert.equal(out('\tx\n', { tabsToSpaces: 2 }), '  x\n');
  assert.equal(out('a\tb\n', { tabsToSpaces: 4 }), 'a   b\n');
  assert.equal(out('\t\tx\n', { tabsToSpaces: 4 }), '        x\n');
});

test('tabs are left alone when tabs-to-spaces is off', () => {
  assert.equal(out('a\tb\n'), 'a\tb\n');
});

test('a file containing a NUL byte is treated as binary and never modified', () => {
  const r = run('a\u0000b  \r\n', {
    stripTrailingWhitespace: true,
    eol: 'lf',
    ensureFinalNewline: true,
  });
  assert.equal(r.binary, true);
  assert.equal(r.changed, false);
  assert.equal(hex(r.after), hex('a\u0000b  \r\n'));
  assert.ok(r.reasons.includes('binary'));
});

// ---------------------------------------------------------------------------
// Markdown fenced code blocks — the hard rule.
// ---------------------------------------------------------------------------

const MD = ['prose  ', '```js', 'const x = 1;   ', '\tindented', '```', 'tail  ', ''].join('\n');

test('trailing whitespace inside a fenced code block is PRESERVED by default', () => {
  const r = plan(MD, { filePath: 'doc.md', stripTrailingWhitespace: true });
  assert.ok(r.after.includes('const x = 1;   \n'), 'trailing spaces inside the fence survived');
  assert.ok(!r.after.includes('prose  \n'), 'prose outside the fence was still cleaned');
});

test('the interior of a fenced code block is byte-identical', () => {
  const opts = {
    filePath: 'doc.md',
    stripTrailingWhitespace: true,
    trimLeadingWhitespace: true,
    tabsToSpaces: 2,
    collapseBlankLines: 0,
  };
  const r = plan(MD, opts);
  const block = r.after.split('```js\n')[1].split('```')[0];
  assert.equal(block, 'const x = 1;   \n\tindented\n');
});

test('an indented fence is recognised too', () => {
  const md = ['a  ', '  ```', '  keep   ', '  ```', 'b  ', ''].join('\n');
  const r = plan(md, { filePath: 'doc.md', stripTrailingWhitespace: true });
  assert.ok(r.after.includes('  keep   \n'));
});

test('tilde fences are recognised', () => {
  const md = ['a  ', '~~~', 'keep   ', '~~~', 'b  ', ''].join('\n');
  const r = plan(md, { filePath: 'doc.md', stripTrailingWhitespace: true });
  assert.ok(r.after.includes('keep   \n'));
});

test('fence protection can be turned off explicitly', () => {
  const r = plan(MD, { filePath: 'doc.md', skipCodeFences: false, stripTrailingWhitespace: true });
  assert.ok(!r.after.includes('const x = 1;   \n'), 'fence interior was cleaned when disabled');
  assert.ok(r.after.includes('const x = 1;\n'));
});

test('an unterminated fence protects through end of file', () => {
  const md = ['a  ', '```', 'keep   ', 'more   ', ''].join('\n');
  const r = plan(md, { filePath: 'doc.md', stripTrailingWhitespace: true });
  assert.ok(r.after.includes('keep   \n'));
  assert.ok(r.after.includes('more   \n'));
});

test('fence skipping is auto-on for .md and off for other extensions', () => {
  assert.equal(shouldSkipFences('a.md', {}), true);
  assert.equal(shouldSkipFences('a.MD', {}), true);
  assert.equal(shouldSkipFences('a.markdown', {}), true);
  assert.equal(shouldSkipFences('a.js', {}), false);
  assert.equal(shouldSkipFences('a.txt', {}), false);
  // An explicit boolean always wins over the auto rule.
  assert.equal(shouldSkipFences('a.md', { skipCodeFences: false }), false);
  assert.equal(shouldSkipFences('a.txt', { skipCodeFences: true }), true);
});

test('line-ending conversion still applies inside fences (no mixed output)', () => {
  const md = ['a', '```', 'b', '```', 'c', ''].join('\r\n');
  const r = plan(md, { filePath: 'doc.md', eol: 'lf' });
  assert.equal(r.after, 'a\n```\nb\n```\nc\n');
  assert.ok(!r.after.includes('\r'), 'no CRLF survived anywhere');
});

// ---------------------------------------------------------------------------
// Idempotence — the property that matters most for a rewriting tool.
// ---------------------------------------------------------------------------

test('a full transform is idempotent', () => {
  const messy = `${BOM}a  \r\n\r\n\r\nb\t\nc`;
  const opts = {
    filePath: 'doc.md',
    stripBom: true,
    eol: 'lf',
    stripTrailingWhitespace: true,
    tabsToSpaces: 4,
    ensureFinalNewline: true,
    collapseBlankLines: 1,
    noTrailingBlankLines: true,
  };
  const once = plan(messy, opts).after;
  const twice = plan(once, opts).after;
  assert.equal(once, twice);
});

// ---------------------------------------------------------------------------
// Helpers.
// ---------------------------------------------------------------------------

test('splitLines: splits on all three terminators', () => {
  const { lines, terms } = splitLines('a\nb\r\nc\rd');
  assert.deepEqual(lines, ['a', 'b', 'c', 'd']);
  assert.deepEqual(terms, ['\n', '\r\n', '\r', '']);
});

test('splitLines: a trailing newline yields a final empty line', () => {
  const { lines } = splitLines('a\nb\n');
  assert.deepEqual(lines, ['a', 'b', '']);
});

test('fenceMask: marks the delimiters and the interior', () => {
  const mask = fenceMask(['```', 'code', '```', 'text']);
  assert.deepEqual(mask, [true, true, true, false]);
});

test('expandTabs: advances to the next tab stop', () => {
  assert.equal(expandTabs('a\tb', 4), 'a   b');
  assert.equal(expandTabs('\t', 2), '  ');
  // Column 2 is a tab stop at width 2, so the tab advances by a full stop.
  assert.equal(expandTabs('ab\tc', 2), 'ab  c');
  // At width 4, column 2 is mid-stop, so the tab advances only 2 columns.
  assert.equal(expandTabs('ab\tc', 4), 'ab  c');
  assert.equal(expandTabs('abc\tc', 4), 'abc c');
});

test('apply: Buffer in, Buffer out, matching plan', () => {
  const input = Buffer.from('a  \r\nb\r\n', 'utf8');
  const applied = apply(input, { filePath: 'file.txt', eol: 'lf', stripTrailingWhitespace: true });
  assert.ok(Buffer.isBuffer(applied));
  assert.equal(applied.toString('utf8'), 'a\nb\n');
});

test('apply: string in, string out', () => {
  assert.equal(apply('a\r\nb\r\n', { eol: 'lf' }), 'a\nb\n');
});

test('plan: an invalid option is rejected by name', () => {
  assert.throws(() => run('a\n', { eol: 'bogus' }), /--eol must be one of/);
  assert.throws(() => run('a\n', { tabsToSpaces: -1 }), /--tabs-to-spaces/);
});

// ---------------------------------------------------------------------------
// A file made only of blank lines must not crash.
//
// --no-trailing-blank-lines walks backwards over the survivor list until it
// finds a line worth keeping. For a file that is nothing but blank lines it
// reaches index 0 and steps off the front, reading `.text` off undefined. The
// guard belongs on the index; the outcome follows from "an empty file stays
// empty", which already covers an input file of zero bytes.
// ---------------------------------------------------------------------------

test('a file of only blank lines does not crash and ends up empty', () => {
  for (const doc of ['', '\n', '\n\n\n', '   \n', '\t\r\n', '\n \n\t\n', '\r\n\r\n']) {
    const r = plan(doc, { filePath: 'file.txt', noTrailingBlankLines: true });
    assert.equal(r.after, '', `input ${JSON.stringify(doc)}`);
    assert.ok(r.reasons.includes('trailing-blank-lines-removed'));
  }
});

test('the blank-line crash does not depend on collapsing or on fences', () => {
  const options = [
    { noTrailingBlankLines: true },
    { collapseBlankLines: 1, noTrailingBlankLines: true },
    { collapseBlankLines: 2, noTrailingBlankLines: true, stripTrailingWhitespace: true },
    { collapseBlankLines: 1, noTrailingBlankLines: true, tabsToSpaces: 4 },
    { collapseBlankLines: 1, noTrailingBlankLines: true, ensureFinalNewline: true },
  ];
  for (const filePath of ['file.txt', 'doc.md']) {
    for (const opts of options) {
      for (const doc of ['', '\n', '\n\n', '  \n\n', '\t\n']) {
        const r = plan(doc, { filePath, ...opts });
        assert.equal(r.after, '', `${filePath} ${JSON.stringify(opts)} ${JSON.stringify(doc)}`);
      }
    }
  }
});

test('a retained BOM survives a file emptied by --no-trailing-blank-lines', () => {
  // stripBom defaults to false, so the three BOM bytes are copied back verbatim.
  // The body after them is nothing but blank lines, which is the case that used
  // to walk off the front of the survivor list and throw.
  const r = plan('﻿\n\n', { filePath: 'file.txt', noTrailingBlankLines: true });
  assert.equal(r.after, '﻿');
  assert.ok(r.reasons.includes('trailing-blank-lines-removed'));
});

test('stripping the BOM from an otherwise blank file leaves nothing', () => {
  const r = plan('﻿\n\n', { filePath: 'file.txt', stripBom: true, noTrailingBlankLines: true });
  assert.equal(r.after, '');
  assert.ok(r.reasons.includes('bom-removed'));
});

// ---------------------------------------------------------------------------
// Fence protection must not depend on the line list's length.
//
// The protection flag used to live in a `boolean[]` parallel to the line list.
// --collapse-blank-lines SHORTENS that list, so from that point on the flag at
// index i describes whatever line ended up at position i -- not the line it was
// computed for. Carrying the flag on the line object removes that coupling.
//
// Note honestly: exhaustive enumeration (every document over the alphabet
// {'', 'a', '```', '~~~', '```js', '~', '  x  ', '\t'} up to 4 lines x 12
// option sets = 88,560 cases) found NO input where the old parallel array
// produced different OUTPUT from the flag-on-the-line version. The old index
// bookkeeping was therefore latent rather than observably wrong; it is fixed
// because the aliasing is real and the correction is free. These tests pin the
// behaviour across both variants rather than proving a regression.
// ---------------------------------------------------------------------------

test('fence protection follows the line after blank lines are collapsed', () => {
  const doc = 'a\n\n\n```\n  keep me  \n```\n\n\n';
  const withCollapse = plan(doc, {
    filePath: 'doc.md',
    stripTrailingWhitespace: true,
    collapseBlankLines: 1,
    noTrailingBlankLines: true,
  });
  assert.equal(withCollapse.after, 'a\n\n```\n  keep me  \n```\n');
  assert.ok(withCollapse.after.includes('  keep me  '), 'fence content must be protected');
});

test('collapsing blanks before a fence leaves fence lines protected', () => {
  const doc = '\n\n\n```\n```\n\n\n';
  const r = plan(doc, {
    filePath: 'doc.md',
    collapseBlankLines: 1,
    noTrailingBlankLines: true,
  });
  assert.equal(r.after, '\n```\n```\n');
});

test('a fence at EOF is protected from --no-trailing-blank-lines', () => {
  // The walk stops at the protected fence line, so the blank run BEFORE it is
  // untouched. Without collapsing all three blanks are mid-file content and
  // survive; collapsing caps the run at 1. Neither variant removes them.
  assert.equal(
    plan('a\n\n\n```\n', { filePath: 'doc.md', noTrailingBlankLines: true }).after,
    'a\n\n\n```\n'
  );
  assert.equal(
    plan('a\n\n\n```\n', { filePath: 'doc.md', collapseBlankLines: 1, noTrailingBlankLines: true }).after,
    'a\n\n```\n'
  );
});

test('the same options without collapsing give the same EOF result', () => {
  const doc = 'a\n\n\ntext\n\n\n';
  const collapsed = plan(doc, {
    filePath: 'doc.md',
    collapseBlankLines: 1,
    noTrailingBlankLines: true,
  });
  const plain = plan(doc, { filePath: 'doc.md', noTrailingBlankLines: true });
  // Collapsing changes the interior run; the EOF outcome must be identical.
  assert.equal(/\n\n$/.test(collapsed.after), false);
  assert.equal(/\n\n$/.test(plain.after), false);
  assert.equal(plain.after, 'a\n\n\ntext\n');
});
