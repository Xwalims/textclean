'use strict';

const { detectBom, hasFinalNewline, analyzeBuffer } = require('./detect.js');
const { normalizeOptions, MARKDOWN_EXTENSIONS } = require('./options.js');

/**
 * The transformations.
 *
 * Design decisions worth knowing about (all covered by tests):
 *
 * 1. Work happens on text that was decoded from the raw buffer; the BOM is
 *    detected on BYTES first (src/detect.js) and removed by length, never by
 *    guessing after decoding.
 *
 * 2. Line-ending conversion is GLOBAL, including inside fenced code blocks.
 *    Converting only the prose would leave a file with mixed terminators, which
 *    is precisely the defect this tool exists to remove. The fence protection
 *    applies to the WHITESPACE-SENSITIVE transforms, where a stray edit is a
 *    semantic change:
 *      - --strip-trailing-whitespace  (trailing spaces can be Markdown hard
 *        line breaks, and are load-bearing in ASCII art / diff blocks)
 *      - --trim-leading-whitespace   (indentation is the code)
 *      - --tabs-to-spaces            (column alignment inside a fence)
 *      - --collapse-blank-lines      (paragraph spacing inside examples)
 *    Fence delimiter lines themselves are protected too.
 *
 * 3. Line COUNT is preserved by every transform except --collapse-blank-lines
 *    and --no-trailing-blank-lines, which only ever REMOVE lines. That is what
 *    lets src/diff.js do a cheap positional diff.
 */

/** Trailing/leading whitespace: space, tab, form feed, vertical tab. */
const WS_EDGE = '[ \\t\\f\\v]';
const TRAILING_WS_RE = new RegExp(WS_EDGE + '+$');
const LEADING_WS_RE = new RegExp('^' + WS_EDGE + '+');
const BLANK_RE = new RegExp('^' + WS_EDGE + '*$');

/** Opening fence: up to 3 spaces of indent, then ``` or ~~~ (3+). */
const OPEN_FENCE_RE = /^ {0,3}(`{3,}|~{3,})(.*)$/;
/** Closing fence: up to 3 spaces of indent, marker, then nothing but spaces. */
const CLOSE_FENCE_RE = new RegExp('^ {0,3}(`{3,}|~{3,})' + WS_EDGE + '*$');

const EOL_RE = /\r\n|\n|\r/g;

/**
 * Split text into lines plus the terminator that followed each line.
 * A trailing empty string is never produced for the final fragment, so
 * "a\nb\n" yields lines ['a','b'] with terminators ['\n','\n'].
 *
 * @param {string} text
 * @returns {{lines: string[], terms: string[]}}
 */
function splitLines(text) {
  const lines = [];
  const terms = [];
  if (text === '') {
    return { lines: [''], terms: [''] };
  }
  EOL_RE.lastIndex = 0;
  let last = 0;
  let match;
  while ((match = EOL_RE.exec(text)) !== null) {
    lines.push(text.slice(last, match.index));
    terms.push(match[0]);
    last = match.index + match[0].length;
  }
  lines.push(text.slice(last));
  terms.push('');
  return { lines, terms };
}

/**
 * Mark the lines that belong to a fenced code block, including the opening and
 * closing delimiter lines. An unterminated fence protects through EOF
 * (matches CommonMark, and is the safe direction).
 *
 * @param {string[]} lines
 * @returns {boolean[]}
 */
function fenceMask(lines) {
  const mask = new Array(lines.length).fill(false);
  let openChar = null;
  let openLength = 0;

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (openChar !== null) {
      mask[i] = true;
      const close = CLOSE_FENCE_RE.exec(line);
      if (close && close[1][0] === openChar && close[1].length >= openLength) {
        openChar = null;
        openLength = 0;
      }
      continue;
    }
    const open = OPEN_FENCE_RE.exec(line);
    if (!open) continue;
    const marker = open[1];
    const info = open[2] || '';
    // A backtick fence's info string may not contain a backtick (CommonMark).
    if (marker[0] === '`' && info.includes('`')) continue;
    openChar = marker[0];
    openLength = marker.length;
    mask[i] = true;
  }
  return mask;
}

/** Expand tabs to the next tab stop of width `width`. */
function expandTabs(line, width) {
  let out = '';
  let col = 0;
  for (const ch of line) {
    if (ch === '\t') {
      const advance = width - (col % width);
      out += ' '.repeat(advance);
      col += advance;
    } else {
      out += ch;
      col += 1;
    }
  }
  return out;
}

/** Resolve the effective "skip fenced code blocks" decision for a file. */
function shouldSkipFences(filePath, options) {
  if (typeof options.skipCodeFences === 'boolean') return options.skipCodeFences;
  if (!filePath) return false;
  const dot = filePath.lastIndexOf('.');
  const ext = dot === -1 ? '' : filePath.slice(dot).toLowerCase();
  return MARKDOWN_EXTENSIONS.includes(ext);
}

/** The terminator that --eol / --ensure-crlf selects, or null for 'keep'. */
function targetEol(options) {
  if (options.ensureCrlf) return '\r\n';
  switch (options.eol) {
    case 'lf':
      return '\n';
    case 'crlf':
      return '\r\n';
    case 'cr':
      return '\r';
    default:
      return null;
  }
}

/**
 * Run the plan without touching the filesystem.
 *
 * @param {string|Buffer} content
 * @param {object} [rawOptions]
 * @returns {{changed: boolean, before: string, after: string, reasons: string[],
 *            analysis: object, binary: boolean, supported: boolean, reason: string|null}}
 *   `before`/`after` are the decoded texts. `after === before` when unchanged.
 */
function plan(content, rawOptions = {}) {
  const options = normalizeOptions(rawOptions);
  const filePath = rawOptions.filePath || null;

  const buffer = Buffer.isBuffer(content) ? content : Buffer.from(String(content), 'utf8');
  const analysis = analyzeBuffer(buffer);

  const before = buffer.toString('utf8');
  const base = {
    before,
    after: before,
    changed: false,
    reasons: [],
    analysis,
    binary: analysis.binary,
    supported: analysis.supported,
    reason: analysis.reason,
  };

  // Encoding is checked BEFORE binary: a UTF-16 text file trips the NUL-byte
  // heuristic, and telling the user "binary, skipped" when the real answer is
  // "this is UTF-16, re-save it as UTF-8" would be a misleading diagnostic.
  if (!analysis.supported) {
    base.reasons.push('unsupported-encoding');
    return base;
  }
  if (analysis.binary) {
    base.reasons.push('binary');
    return base;
  }

  const skipFences = shouldSkipFences(filePath, options);
  const eol = targetEol(options);
  const reasons = new Set();

  // --- BOM -----------------------------------------------------------------
  // Located on the BYTES (src/detect.js) and removed by byte LENGTH. The BOM
  // bytes are never decoded, so they can never become U+FEFF content, be
  // counted as whitespace, or be re-encoded wrongly.
  //
  // `skipBytes` is always the BOM length: the BOM is cut off the front before
  // decoding no matter what. `keepBytes` is what gets copied back verbatim on
  // the way out. Keeping them separate is what makes "preserve the BOM" and
  // "strip the BOM" both correct — and stops the BOM being emitted twice.
  const bomBytes = analysis.bom.encoding === 'utf8' ? analysis.bom.length : 0;
  const skipBytes = bomBytes;
  let keepBytes = bomBytes;
  if (options.stripBom && bomBytes > 0) {
    keepBytes = 0;
    reasons.add('bom-removed');
  }
  const body = buffer.subarray(skipBytes).toString('utf8');

  // --- line model ----------------------------------------------------------
  const { lines: rawLines, terms } = splitLines(body);
  // Each line keeps the terminator that FOLLOWED it, so a removed line takes
  // its own terminator with it and the survivors stay correctly separated.
  //
  // The fence-protection flag rides ON THE LINE rather than in a parallel
  // `boolean[]`. That matters because --collapse-blank-lines SHORTENS the line
  // list: a parallel array would still be indexed by the original line numbers,
  // so after the list is filtered the flag at any given index would describe a
  // different line. Carrying it with the line makes the later passes immune to
  // the shift by construction.
  const rawMask = skipFences ? fenceMask(rawLines) : new Array(rawLines.length).fill(false);
  const lines = rawLines.map((text, i) => ({
    text,
    term: terms[i],
    protected: rawMask[i],
  }));

  // splitLines yields a final EMPTY line exactly when the text ended with a
  // newline ('a\nb\n' -> ['a','b',''], but 'a\nb' -> ['a','b']). That empty
  // line IS the terminator. Reading the terminator off terms[last] instead
  // would be wrong, because terms[last] is always ''.
  const endsWithNewline = lines.length > 1 && lines[lines.length - 1].text === '';
  const hadFinalNewline = endsWithNewline;
  const originalFinalTerm = hadFinalNewline ? terms[terms.length - 2] : '';

  for (let i = 0; i < lines.length; i += 1) {
    if (lines[i].protected) continue;
    let line = lines[i].text;

    if (options.tabsToSpaces > 0 && line.includes('\t')) {
      const expanded = expandTabs(line, options.tabsToSpaces);
      if (expanded !== line) reasons.add('tabs-expanded');
      line = expanded;
    }
    if (options.trimLeadingWhitespace) {
      const trimmed = line.replace(LEADING_WS_RE, '');
      if (trimmed !== line) reasons.add('leading-whitespace-trimmed');
      line = trimmed;
    }
    if (options.stripTrailingWhitespace) {
      const trimmed = line.replace(TRAILING_WS_RE, '');
      if (trimmed !== line) reasons.add('trailing-whitespace-stripped');
      line = trimmed;
    }
    lines[i].text = line;
  }

  // --- blank-line collapsing ----------------------------------------------
  let working = lines;
  if (options.collapseBlankLines > 0) {
    const kept = [];
    let run = 0;
    for (let i = 0; i < working.length; i += 1) {
      const blank = !working[i].protected && BLANK_RE.test(working[i].text);
      if (!blank) {
        run = 0;
        kept.push(working[i]);
        continue;
      }
      run += 1;
      if (run <= options.collapseBlankLines) kept.push(working[i]);
      else reasons.add('blank-lines-collapsed');
    }
    working = kept;
  }

  // --- trailing blank lines ------------------------------------------------
  // Applied in the reassembly section below, where the terminator bookkeeping
  // is resolved; removing the lines here alone would lose the final newline.

  // --- reassemble ----------------------------------------------------------
  const wantFinal = options.ensureFinalNewline
    ? true
    : options.noFinalNewline
      ? false
      : hadFinalNewline;

  // The terminator to place after the final line when one is wanted.
  const lastTerminator = eol !== null ? eol : originalFinalTerm || '\n';

  // Trailing blank-line removal happens HERE, after the join, so that the final
  // newline survives it: 'a\n\n\n' joined is 'a\n\n\n', the trailing blanks go
  // (including the empty line that was the terminator), and the answer is then
  // re-terminated below to exactly one newline. Removing the lines earlier lost
  // the terminator and made the tool non-idempotent.
  let surviving = working;
  if (options.noTrailingBlankLines) {
    let end = surviving.length;
    // `end` walks BACKWARDS, so `surviving[end - 1]` is undefined as soon as
    // `end` reaches 0. That happens for a file that is nothing but blank lines,
    // which every pass above can legitimately reduce to an empty list; the
    // guard stops the walk reading `.text` off undefined.
    while (end > 0 && !surviving[end - 1].protected && BLANK_RE.test(surviving[end - 1].text)) {
      end -= 1;
    }
    if (end < surviving.length) {
      reasons.add('trailing-blank-lines-removed');
      surviving = surviving.slice(0, end);
    }
  }

  // Every line was blank and every one was dropped. There is nothing left to
  // terminate, so the result is the empty string rather than a lone newline:
  // "an empty file stays empty" applies to a file emptied by this pass too.
  if (surviving.length === 0) {
    reasons.add('trailing-blank-lines-removed');
    return {
      ...base,
      after: buffer.subarray(0, keepBytes).toString('utf8'),
      changed: keepBytes !== buffer.length,
      reasons: Array.from(reasons),
    };
  }

  // Join every line with its own terminator. This already reproduces the whole
  // file: in 'keep' mode each line carries the terminator it had, and in
  // conversion mode every terminator is replaced by the requested one.
  const parts = [];
  for (let i = 0; i < surviving.length - 1; i += 1) {
    parts.push(surviving[i].text, eol !== null ? eol : surviving[i].term || '\n');
  }
  parts.push(surviving[surviving.length - 1].text);
  let newBody = parts.join('');

  // Decide the tail from the joined text itself rather than from bookkeeping
  // about which line was last. Asking "does this end with a newline?" is the
  // only question that cannot drift out of sync with the bytes.
  const bodyEndsWithNewline = newBody !== '' && /[\n\r]$/.test(newBody);

  if (wantFinal && !bodyEndsWithNewline) {
    newBody += lastTerminator;
    reasons.add('final-newline-added');
  } else if (!wantFinal && bodyEndsWithNewline) {
    newBody = newBody.replace(/[\r\n]+$/, '');
    reasons.add('final-newline-removed');
  }

  // An empty file stays empty: a newline added to zero bytes is noise.
  if (buffer.length === skipBytes) newBody = '';

  // Reassemble as bytes so a retained BOM is copied verbatim. Round-tripping it
  // through a JS string would re-encode EF BB BF, which is the classic way a
  // "we only removed whitespace" change silently corrupts a file.
  const out = Buffer.concat([buffer.subarray(0, keepBytes), Buffer.from(newBody, 'utf8')]);
  const after = out.toString('utf8');

  return {
    ...base,
    after,
    changed: !out.equals(buffer),
    reasons: Array.from(reasons),
  };
}

/**
 * Apply the plan and return the new content in the same representation as the
 * input (Buffer in, Buffer out).
 *
 * @param {string|Buffer} content
 * @param {object} [options]
 * @returns {Buffer|string}
 */
function apply(content, options = {}) {
  const wasBuffer = Buffer.isBuffer(content);
  const result = plan(content, options);
  return wasBuffer ? Buffer.from(result.after, 'utf8') : result.after;
}

module.exports = {
  plan,
  apply,
  splitLines,
  fenceMask,
  expandTabs,
  shouldSkipFences,
  targetEol,
  detectBom,
};
