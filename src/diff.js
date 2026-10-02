'use strict';

/**
 * A minimal unified-diff renderer.
 *
 * Deliberately NOT a general diff algorithm. Every transform in src/normalize.js
 * preserves line ORDER and line COUNT, except --collapse-blank-lines and
 * --no-trailing-blank-lines, which only ever REMOVE lines. So a positional
 * (index-by-index) comparison is a complete and correct description of the
 * change. No Myers, no LCS, no heuristics — and therefore no way to emit a
 * subtly wrong hunk.
 *
 * Lines that only differ in their terminator are reported too, with a visible
 * marker, because "CRLF -> LF" is invisible otherwise and it is exactly what
 * this tool exists to reveal.
 */

/** Hunk context lines around each change. */
const CONTEXT = 3;

/** @typedef {{text: string, term: string}} Line */

/**
 * Render a unified diff for a single file.
 *
 * @param {string} beforeText
 * @param {string} afterText
 * @param {string} label path shown in the ---/+++ headers
 * @param {{context?: number}} [opts]
 * @returns {string} '' when the texts are identical
 */
function unifiedDiff(beforeText, afterText, label = 'a/b', opts = {}) {
  if (beforeText === afterText) return '';
  const context = Number.isInteger(opts.context) ? opts.context : CONTEXT;

  const before = toLines(beforeText);
  const after = toLines(afterText);

  const pairs = align(before, after);

  const hunks = buildHunks(pairs, context);
  if (hunks.length === 0) return '';

  // Each hunk arrives as [header, ...entries]: the header is a pre-built string
  // and only the entries after it are line records to render.
  const body = hunks
    .map((h) => [h[0], ...h.slice(1).map((entry) => renderEntry(entry))].join('\n'))
    .join('\n');

  return `--- a/${label}\n+++ b/${label}\n${body}\n`;
}

function toLines(text) {
  const out = [];
  const re = /\r\n|\n|\r/g;
  let last = 0;
  let match;
  while ((match = re.exec(text)) !== null) {
    out.push({ text: text.slice(last, match.index), term: match[0] });
    last = match.index + match[0].length;
  }
  out.push({ text: text.slice(last), term: '' });
  return out;
}

/**
 * Positional alignment.
 *
 * Every transform in src/normalize.js preserves line order and line count, so
 * walking both lists in lockstep is a complete alignment — no LCS needed.
 * Three outcomes per position:
 *   - identical              -> ' ' (context)
 *   - same once trailing ws is ignored, or a terminator differs -> '-'/'+' pair
 *     rendered as a single line, because a trailing-space fix reads better as
 *     one changed line than as a delete plus an unrelated insert
 *   - anything else          -> '-' then, if the texts re-align, '+'
 */
function align(before, after) {
  const pairs = [];
  let bi = 0;
  let ai = 0;

  while (bi < before.length && ai < after.length) {
    const b = before[bi];
    const a = after[ai];

    if (b.text === a.text && b.term === a.term) {
      pairs.push({ type: ' ', before: b, after: a });
      bi += 1;
      ai += 1;
      continue;
    }

    // A terminator-only difference on otherwise identical text. Rendered as one
    // changed line showing the old terminator, since showing "-a\r\n / +a" for
    // every line of a CRLF file is pure noise.
    if (b.text === a.text) {
      pairs.push({ type: '~', before: b, after: a });
      bi += 1;
      ai += 1;
      continue;
    }

    // A whitespace-only difference on a matching line: emit the pair so the
    // trailing-space removal is visible in the diff.
    if (sameIgnoringEolWhitespace(b, a)) {
      pairs.push({ type: '-', before: b });
      pairs.push({ type: '+', after: a });
      bi += 1;
      ai += 1;
      continue;
    }

    pairs.push({ type: '-', before: b });
    bi += 1;
  }
  while (bi < before.length) {
    pairs.push({ type: '-', before: before[bi] });
    bi += 1;
  }
  while (ai < after.length) {
    pairs.push({ type: '+', after: after[ai] });
    ai += 1;
  }
  return pairs;
}

function sameIgnoringEolWhitespace(b, a) {
  return b.text.replace(/[ \t]+$/, '') === a.text.replace(/[ \t]+$/, '');
}

function renderEntry(entry) {
  if (entry.type === ' ') {
    // A context line with no terminator is the last line of a file that lacks a
    // final newline. Say so explicitly, the way every other diff tool does,
    // rather than leaving the reader to guess.
    return entry.before.term === '' ? ` ${entry.before.text}${NO_NEWLINE}` : ` ${entry.before.text}`;
  }
  // Same marker for a changed line that ends the file without a newline.
  if (entry.type === '-') {
    return entry.before.term === ''
      ? `-${entry.before.text}${NO_NEWLINE}`
      : `-${entry.before.text}${showTerm(entry.before.term)}`;
  }
  if (entry.type === '+') {
    return entry.after.term === ''
      ? `+${entry.after.text}${NO_NEWLINE}`
      : `+${entry.after.text}${showTerm(entry.after.term)}`;
  }
  return `-${entry.before.text}${showTerm(entry.before.term)}`;
}

/** Trailing marker for the last line of a file with no final newline. */
const NO_NEWLINE = '  (no newline at end of file)';

/**
 * Show the terminator when it is not the ordinary LF, so CRLF/CR differences
 * and a missing final newline are legible instead of invisible.
 */
function showTerm(term) {
  if (term === '' || term === '\n') return '';
  return term.replace(/\r/g, '\\r').replace(/\n/g, '\\n');
}

/** Group the paired entries into hunks with proper @@ headers. */
function buildHunks(pairs, context) {
  // A '~' line is a change that occupies one slot in both files, so it counts
  // toward both the before and after counts exactly like a context line.
  const interesting = [];
  for (let i = 0; i < pairs.length; i += 1) {
    if (pairs[i].type !== ' ') interesting.push(i);
  }
  if (interesting.length === 0) return [];

  // Merge nearby runs of interesting indices into hunk ranges.
  const ranges = [];
  for (const index of interesting) {
    const last = ranges[ranges.length - 1];
    if (last && index - last[1] <= context * 2 + 1) {
      last[1] = index;
    } else {
      ranges.push([index, index]);
    }
  }

  return ranges.map(([start, end]) => {
    const from = Math.max(0, start - context);
    const to = Math.min(pairs.length - 1, end + context);
    const slice = pairs.slice(from, to + 1);

    // A '~' line occupies a slot in BOTH files (only its terminator changed), so it
  // advances and counts like a context line. '-' and '+' advance one side only.
  const occupiesBoth = (type) => type === ' ' || type === '~';

  let beforeStart = 0;
    let afterStart = 0;
    for (let i = 0; i < from; i += 1) {
      const entry = pairs[i];
      if (occupiesBoth(entry.type)) { beforeStart += 1; afterStart += 1; }
      else if (entry.type === '-') beforeStart += 1;
      else afterStart += 1;
    }
    let beforeCount = 0;
    let afterCount = 0;
    for (const entry of slice) {
      if (occupiesBoth(entry.type)) { beforeCount += 1; afterCount += 1; }
      else if (entry.type === '-') beforeCount += 1;
      else afterCount += 1;
    }

    const header =
      `@@ -${beforeStart + 1},${beforeCount} +${afterStart + 1},${afterCount} @@`;
    return [header, ...slice];
  });
}

module.exports = { unifiedDiff, toLines, CONTEXT };
