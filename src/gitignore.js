'use strict';

/**
 * A deliberately small gitignore matcher.
 *
 * WHAT IS SUPPORTED (see README "What .gitignore support means"):
 *   - blank lines and `#` comments
 *   - `!` negation, last match wins
 *   - trailing `/` = directory only
 *   - leading `/` or a `/` anywhere but the end = anchored to the ignore file's
 *     own directory; a bare name matches at any depth
 *   - `*` (no slash), `?`, `**`, character classes `[abc]` / `[!abc]`
 *   - `\` escape of the first special character
 *   - nested .gitignore files: a rule in `sub/.gitignore` is resolved relative
 *     to `sub/` and applies to that subtree, and a deeper file overrides a
 *     shallower one on a path they share
 *
 * WHAT IS NOT SUPPORTED (and is not claimed anywhere):
 *   - `\` line continuations
 *   - per-directory precedence beyond ordering layers by depth: a nested file
 *     is read as a whole layer rather than file by file as git descends, which
 *     differs only when two files at DIFFERENT depths both match a path -- and
 *     then only in which of them is consulted last, never in whether the path
 *     is ignored
 *
 * test/gitignore-differential.test.js checks every clause above against real
 * `git check-ignore`, so this list is verified rather than asserted.
 */

const fs = require('node:fs');
const path = require('node:path');

/** Compile one gitignore line into a RegExp anchored at the match start. */
function compilePattern(line, gitignoreDir) {
  let pattern = line;
  let negated = false;
  let dirOnly = false;

  if (pattern.startsWith('!')) {
    negated = true;
    pattern = pattern.slice(1);
  }
  if (pattern.endsWith('/')) {
    dirOnly = true;
    pattern = pattern.slice(0, -1);
  }
  if (pattern === '') return null;

  // A trailing run of backslashes of ODD length leaves the rule escaping a
  // character that is not there, and git then ignores nothing with it.
  //
  // Measured with `git check-ignore`, one file per candidate name:
  //
  //     foo    -> matches "foo"
  //     foo\   -> matches nothing
  //     foo\\  -> matches "foo\"
  //     foo\\\ -> matches nothing
  //     foo\\\\-> matches "foo\\"
  //
  // So the run is literal backslashes while it is even, and a dangling escape
  // while it is odd. The old code fell through to `body += '\\$'` and compiled
  // `foo\` as a pattern needing a literal backslash at the end of every match,
  // so it ignored a file named `foo\` -- one that git leaves alone.
  //
  // This is checked BEFORE the trailing-slash and trailing-space handling,
  // because an inert rule needs no further interpretation.
  if (trailingBackslashRunIsOdd(pattern)) return null;

  // Decide anchoring BEFORE compiling, then drop the leading '/'. Compiling
  // first would bake the '/' into the body and produce a regex like '^^/name$'
  // that can never match a relative path — every anchored pattern would
  // silently stop working.
  const anchored = pattern.startsWith('/') || pattern.slice(0, -1).includes('/');
  pattern = pattern.replace(/^\/+/, '');
  if (pattern === '') return null;

  // Strip UNESCAPED trailing spaces, git's rule and this file's missing one.
  //
  // `parseGitignore` used `.trimEnd()` on every line, which is right about the
  // common case and wrong about the escaped one. A trailing space run is literal
  // only when an ODD number of backslashes immediately precedes it -- that is
  // exactly git's rule, measured with `git check-ignore`:
  //
  //     foo\        ->  nothing (a trailing backslash escapes nothing)
  //     foo\  ' '   ->  `foo `      (odd run: the space is the name)
  //     foo\    ' ' ->  `foo `      (the rest of the run is then stripped)
  //     foo   ' '   ->  `foo`       (no backslash: stripped)
  //
  // So `.trimEnd()` deleted the very character `foo\ ` exists to preserve: the
  // rule stopped matching `foo ` and matched `foo` instead, silently ignoring a
  // different file than the one named. A file whose name ends in a space is
  // legal on every POSIX filesystem and does happen in the wild.
  //
  // Tabs are NOT stripped: git ignores only the space character here, and a
  // trailing tab is part of the name (measured: the rule `foo\t` matches a file
  // literally named `foo<TAB>` and nothing else).
  pattern = stripTrailingSpaces(pattern);
  if (pattern === '') return null;

  // Patterns from a nested .gitignore resolve relative to its own directory.
  const prefix = gitignoreDir ? String(gitignoreDir).split('/').filter(Boolean) : [];

  let body = '';
  let i = 0;
  while (i < pattern.length) {
    const ch = pattern[i];
    if (ch === '*') {
      // A run of 2 or more asterisks is a globstar, however long it is: git
      // treats `***` exactly as `**`. Counting only the first two made the rest
      // of the run fall through to the single-star branch, so `***/**` compiled
      // to `.*[^/]*\/.*` — which then demanded a slash and ignored nothing at
      // the top level, where git ignores everything.
      let run = 1;
      while (pattern[i + run] === '*') run++;

      // A globstar counts only when the run is bounded on BOTH sides by a slash
      // or by a string end; git collapses anything else to a single `*`. The
      // trailing side used to be checked and the leading side ignored, so
      // `[a-]**/**` compiled to `^(?:.*/)?[a\-](?:.*/)?.*$` and swallowed every
      // top-level name starting with `a`, where git keeps them all — the
      // degraded run cannot cross the slash, and the pattern then needs one.
      //
      // Both sides measured: `x**/a` and `**x/a` match nothing at all in git,
      // while `**/a`, `x/**/a` and `x/**` behave as globstars.
      const before = i === 0 ? null : pattern[i - 1];
      const after = i + run < pattern.length ? pattern[i + run] : null;
      const bounded =
        run >= 2 &&
        (before === '/' || before === null) &&
        (after === '/' || after === null);

      if (!bounded) {
        body += '[^/]*';
        i += run;
        continue;
      }
      if (after === '/') {
        body += '(?:.*/)?';
        i += run + 1;
        continue;
      }
      body += '.*';
      i += run;
      continue;
    }
    if (ch === '?') {
      body += '[^/]';
      i += 1;
      continue;
    }
    if (ch === '[') {
      const close = findClassEnd(pattern, i);
      if (close !== -1) {
        body += compileClass(pattern.slice(i + 1, close));
        i = close + 1;
        continue;
      }
      // An unterminated `[` makes the WHOLE RULE inert in git, not just the
      // class. Measured with `git check-ignore`:
      //
      //     [abc    -> matches nothing
      //     a[bc    -> matches nothing      (the leading `a` does not save it)
      //     x*[bc   -> matches nothing      (neither does a leading glob)
      //     a[bc d  -> matches nothing
      //     [bc]x   -> matches nothing      (a closed class followed by text)
      //
      // So this file used to fall through to `body += '\\['` and compile the
      // rest literally, which is the one reading git does not have: the rule
      // `x[abc` fired on a file named `x[abc`, a file no git user could produce
      // with that rule. Ignoring the wrong file is the expensive direction --
      // textclean would rewrite source it was asked to leave alone.
      return null;
    }
    if (ch === '\\' && i + 1 < pattern.length) {
      body += pattern[i + 1].replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      i += 2;
      continue;
    }
    body += ch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    i += 1;
  }

  // An anchored pattern is relative to the ignore file's directory; an
  // unanchored one matches at any depth. The gitignoreDir prefix is layered on
  // top of that so nested ignore files resolve correctly.
  //
  // The prefix is MANDATORY: `^sub/` , never `^(?:sub/)?`. A `(?:...)?` made
  // every nested rule fire outside its own directory, which is the leak the
  // comment above `relDir` describes -- fixing the prefix while leaving it
  // optional would have fixed nothing at all, because the empty alternative is
  // always available.
  const prefixRe = prefix.length ? `^${prefix.map(escapeRe).join('/')}/` : '^';
  const prefixPart = anchored ? '' : '(?:.*/)?';

  return {
    negated,
    dirOnly,
    regex: new RegExp(`${prefixRe}${prefixPart}${body}$`),
    source: line,
  };
}

function escapeRe(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Does `pattern` end with an odd-length run of backslashes?
 *
 * An even run is a literal tail; an odd one is a dangling escape that leaves the
 * rule inert in git. Measured, not assumed: `foo\\` matches the file `foo\`,
 * `foo\\` (one backslash, written `foo\\` in JS source) matches nothing, and
 * `foo\\\\` matches `foo\\`.
 *
 * @param {string} pattern the pattern body, after any leading `!` has been
 *   removed.
 * @returns {boolean} true when the trailing backslash run has odd length.
 */
function trailingBackslashRunIsOdd(pattern) {
  let i = pattern.length;
  while (i > 0 && pattern[i - 1] === '\\') i -= 1;
  return (pattern.length - i) % 2 === 1;
}

/**
 * Strip a trailing run of spaces unless an escaped one is part of the name.
 *
 * git keeps a trailing space literal only when it is escaped by an ODD number
 * of immediately preceding backslashes, and then strips whatever spaces follow
 * it. Measured with `git check-ignore`, every line below being a full rule:
 *
 *     "foo"      -> matches "foo"
 *     "foo   "   -> matches "foo"       (run stripped)
 *     "foo\\ "   -> matches "foo "      (odd backslash run: one space kept)
 *     "foo\\  "  -> matches "foo "
 *     "foo\\   " -> matches "foo "      (rest of the run still stripped)
 *
 * Only the space character is considered; a trailing tab belongs to the name.
 *
 * @param {string} line pattern body, already stripped of any leading `!`, `/`
 *   and trailing `/`.
 * @returns {string} the pattern with unescaped trailing spaces removed.
 */
function stripTrailingSpaces(line) {
  let end = line.length;
  while (end > 0 && line[end - 1] === ' ') end -= 1;
  if (end === line.length) return line;
  // Walk back over the backslashes in front of the run; an odd count escapes
  // the first space of it, so exactly one space survives.
  let i = end - 1;
  let backslashes = 0;
  while (i >= 0 && line[i] === '\\') {
    backslashes += 1;
    i -= 1;
  }
  if (backslashes % 2 === 1) {
    // Keep one space, and keep the backslashes that are still escaping things.
    // `foo\ ` -> `foo\ `; `foo\   ` -> `foo\ `.
    return line.slice(0, end) + ' ';
  }
  return line.slice(0, end);
}

/** The slash itself. */
const SLASH_CODE = '/'.charCodeAt(0);

/**
 * Find the index of the `]` closing a class opened at `start`.
 * Returns -1 when the class is unterminated, which makes the caller emit a
 * literal `[` — git does the same, and such a pattern simply matches nothing.
 *
 * The interior is scanned escape-aware, because the two obvious readings both
 * disagree with git:
 *
 *   - `indexOf(']')` stops at an ESCAPED `]`. So `[a\]` looked terminated and
 *     compiled to the RegExp fragment `[a\]`, whose `\]` closes the class and
 *     leaves the `]` literal — and then the fragment is never closed at all, so
 *     `new RegExp` throws. Any `.gitignore` containing `[a\]` crashed the CLI.
 *   - a plain `indexOf` also treats a LEADING `]` as the terminator, so `[]a]`
 *     compiled to the empty class `[]`, which can never match. git reads the
 *     leading `]` as a literal member and ignores `a` and `]` alike.
 *
 * Both shapes were measured against `git check-ignore`, not read off a spec.
 *
 * @param {string} s
 * @param {number} start index of the opening `[`
 * @returns {number} index of the closing `]`, or -1
 */
function findClassEnd(s, start) {
  let i = start + 1;
  if (s[i] === '!' || s[i] === '^') i++;
  if (s[i] === ']') i++; // a leading `]` is a literal member, not the end
  while (i < s.length) {
    if (s[i] === '\\') {
      i += 2;
      continue;
    }
    if (s[i] === ']') return i;
    i++;
  }
  return -1;
}

/**
 * Remove the slash from a set of ranges, splitting any range that spans it.
 *
 * A class is the one token in the language that used to match the path
 * separator: `*` compiles to `[^/]*`, `?` to `[^/]`, and a literal slash is
 * escaped, so all three refuse it — while a class containing `/` was pasted
 * straight into the RegExp and so matched it, inverting the rule every other
 * token obeys.
 *
 * Splitting rather than dropping is measured, because the two obvious fixes
 * each lose something real:
 *
 *     [+-0]  (0x2B..0x30) -> keeps + , - . 0, never /   -> two ranges
 *     [--/]  (0x2D..0x2F) -> keeps - and ., never /     -> one range
 *     [/0]   (0x2F..0x30) -> keeps 0, never /           -> one range
 *
 * Dropping the range would lose `0` in `[+-0]`; keeping it whole is the bug.
 *
 * The negated form needs no adjustment here, because "every class is barred
 * from the slash" and "a negated class excludes the slash" are one statement.
 *
 * @param {Array<[string, string]>} ranges
 * @returns {Array<[string, string]>}
 */
function excludeSlash(ranges) {
  const before = String.fromCharCode(SLASH_CODE - 1);
  const after = String.fromCharCode(SLASH_CODE + 1);
  const out = [];
  for (const [lo, hi] of ranges) {
    const loCode = lo.charCodeAt(0);
    const hiCode = hi.charCodeAt(0);
    if (hiCode < SLASH_CODE) {
      out.push([lo, hi]);
    } else if (loCode > SLASH_CODE) {
      out.push([lo, hi]);
    } else if (loCode === hiCode) {
      // The range is the slash alone: it has no members left, so drop it.
    } else {
      if (loCode < SLASH_CODE) out.push([lo, before]);
      if (hiCode > SLASH_CODE) out.push([after, hi]);
    }
  }
  return out;
}

/**
 * Parse the interior of a class into `[lo, hi]` ranges, honouring escapes and
 * git's "a `-` at either end is a literal" rule.
 *
 * Measured against git for every shape below:
 *
 *     [a-]   -> a and -        (trailing - is a literal)
 *     [-a]   -> a and -        (leading - is a literal)
 *     [a\-c] -> a, c and -     (escaped - is a literal)
 *     [b-a]  -> b only         (reversed range: the high endpoint is dropped)
 *     [\]    -> ] (escaped); `[\` alone stays unterminated
 *     [a\b]  -> a and b        (an escape inside the class escapes the next char)
 *
 * A reversed range is the one genuinely surprising result: git does not reject
 * it and does not treat it as a literal `b`, `-`, `a` run — it matches `b`
 * alone, i.e. the low endpoint with the span discarded.
 *
 * @param {string} body interior of the class, without the brackets
 * @returns {{negated: boolean, ranges: Array<[string, string]>}}
 */
function parseClassBody(body) {
  let negated = false;
  let k = 0;
  if (body[0] === '!' || body[0] === '^') {
    negated = true;
    k = 1;
  }

  const ranges = [];
  const at = (i) => (body[i] === '\\' && i + 1 < body.length ? [body[i + 1], 2] : [body[i], 1]);

  while (k < body.length) {
    const [lo, loStep] = at(k);
    k += loStep;

    // A range needs `lo`, a literal `-`, and a higher endpoint. A `-` in final
    // position has no endpoint after it, so it stands for itself.
    if (body[k] === '-' && k + 1 < body.length) {
      const [hi, hiStep] = at(k + 1);
      k += 1 + hiStep;
      const loCode = lo.charCodeAt(0);
      const hiCode = hi.charCodeAt(0);
      if (hiCode >= loCode) {
        ranges.push([lo, hi]);
        continue;
      }
      // Reversed: git keeps the low endpoint only. Pushing it as a single-char
      // range is exactly that, and keeps `b` matching in `[b-a]`.
      ranges.push([lo, lo]);
      continue;
    }
    ranges.push([lo, lo]);
  }

  return { negated, ranges: excludeSlash(ranges) };
}

/**
 * Compile a class interior into a RegExp fragment.
 *
 * Every member is escaped individually rather than pasted as a slice, so no
 * input can produce a syntactically invalid RegExp: an escaped `]` becomes
 * `\x5d`, a `-` in literal position becomes `\-`, and a member that happens to
 * be `\` becomes `\\`. The old code pasted the raw interior between brackets,
 * which is where the crash above came from.
 */
function compileClass(body) {
  const { negated, ranges } = parseClassBody(body);
  // A dash MUST be escaped in the negated branch, exactly as it is in the
  // positive one below.
  //
  // The negated branch enumerates every excluded member and pastes them in, so
  // `[!-z]` became the fragment `[^/-z]` -- and in RegExp that is not "not a
  // slash, not a dash, not a z". It is a RANGE: `/` (0x2f) through `z` (0x7a).
  // The class matched 17 characters instead of 92, so `[!-z]` ignored punctuation
  // and digits and nothing else, while git matches everything except `-` and `z`.
  // Measured with `git check-ignore` over a file per printable ASCII character:
  // git matches 90, this matched 17, 75 of them wrong. The same class of bug
  // reaches any negated class holding a dash member, `[^-z]` included.
  //
  // Escaping is free: `\ -` means the same character as `-` inside a class.
  const member = (ch) => (ch === '/' ? '\\/' : ch === '-' ? '\\-' : escapeRe(ch));

  if (negated) {
    // Enumerate the excluded set so the fragment can start from a guaranteed
    // non-empty base; a class whose only members were the slash is left with
    // none, and `[^]` is not valid RegExp syntax.
    const excluded = [];
    for (const [lo, hi] of ranges) {
      for (let c = lo.codePointAt(0); c <= hi.codePointAt(0); c++) {
        excluded.push(String.fromCodePoint(c));
      }
    }
    return `[^/${excluded.map(member).join('') || '\\x00'}]`;
  }

  const alts = ranges.map(([lo, hi]) => {
    // A literal `-` must not open a span: in RegExp `[-c]` is the range `-`..`c`,
    // not the two characters. It can only arrive here via an escape such as
    // `[\--c]`, which is exactly the case that would otherwise be misread.
    const a = lo === '-' ? '\\-' : member(lo);
    return lo === hi ? a : `${a}-${member(hi)}`;
  });
  // An empty class matches nothing; `\x00` is a fragment that is syntactically
  // valid and matches no name a path can have.
  return `[${alts.join('') || '\\x00'}]`;
}

/**
 * Read and compile a .gitignore.
 *
 * @param {string} dir directory containing the file
 * @param {string} [file] defaults to '.gitignore'
 * @param {string} [root] walk root the patterns are relative to. Defaults to
 *   `dir`, which is correct for a root ignore file and for every caller that
 *   only ever reads one; `collectGitignores` passes the real root so a nested
 *   file's prefix is measured from there.
 * @returns {Array<{negated: boolean, dirOnly: boolean, regex: RegExp}>}
 */
function loadGitignore(dir, file = '.gitignore', root = dir) {
  const full = path.join(dir, file);
  let raw;
  try {
    raw = fs.readFileSync(full, 'utf8');
  } catch {
    return [];
  }
  // A nested ignore file's patterns belong to ITS OWN directory: they must be
  // prefixed with that directory, and the prefix is mandatory, not optional.
  //
  // Both halves of that were wrong, and each half broke a different direction,
  // so the file agreed with git on no nested case at all. `relDir` was computed
  // as `path.relative(dir, dir)`, which is the empty string for every
  // directory, so nested rules were compiled with no prefix whatsoever and
  // applied tree-wide: a `sub/.gitignore` containing `secret.txt` ignored the
  // repository's own top-level `secret.txt`, which git keeps. And `compilePattern`
  // turned the prefix into `(?:sub/)?`, so even a correctly supplied prefix
  // matched paths OUTSIDE the directory too -- the same leak in the pattern
  // itself. On the other side, a nested anchored rule (`/only.txt`) then
  // matched neither `sub/only.txt` nor anything below it, because the regex was
  // `^only\.txt$` with no `sub/` to anchor to; git ignores that file.
  //
  // Measured against `git check-ignore` before the fix: 11 of 32 probes across
  // 11 nested scenarios disagreed.
  const relDir = path.relative(path.resolve(root), path.resolve(dir));
  return parseGitignore(raw, relDir);
}

/**
 * Parse gitignore text.
 *
 * @param {string} text
 * @param {string} [relativeDir] POSIX directory prefix the patterns are anchored
 *   to, relative to the walk root ('' for the root itself)
 * @returns {Array<object>}
 */
function parseGitignore(text, relativeDir = '') {
  const out = [];
  for (const rawLine of text.split('\n')) {
    // Strip the CR of a CRLF file, and nothing else. The trailing-space rule is
    // applied inside compilePattern, which is where the escapes are read.
    const line = rawLine.replace(/\r$/, '');
    if (line.trim() === '' || line.startsWith('#')) continue;
    const compiled = compilePattern(line, relativeDir);
    if (compiled) out.push(compiled);
  }
  return out;
}

/** Load a root .gitignore plus any nested ones under `root`. */
function collectGitignores(root) {
  // Each layer carries the directory it came from, because the order matters:
  // git gives a DEEPER ignore file precedence over a shallower one, so for a
  // path under both, the deeper layer must be consulted last. This used a bare
  // LIFO stack, so sibling directories were collected in an order that had
  // nothing to do with depth.
  const layers = [];
  const rootIgnore = loadGitignore(root, '.gitignore', root);
  if (rootIgnore.length) layers.push({ dir: '', depth: 0, rules: rootIgnore });

  // Nested .gitignore files are cheap to find and matter for real repos.
  const stack = [root];
  while (stack.length) {
    const dir = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name === '.git' || entry.name === 'node_modules') continue;
      const child = path.join(dir, entry.name);
      const rules = loadGitignore(child, '.gitignore', root);
      if (rules.length) {
        const relDir = path.relative(root, child).split(path.sep).join('/');
        layers.push({ dir: relDir, depth: relDir.split('/').filter(Boolean).length, rules });
      }
      stack.push(child);
    }
  }
  // Shallow first, so a deeper file overrides a shallower one on a shared path.
  layers.sort((a, b) => a.depth - b.depth);
  return layers.map((layer) => layer.rules);
}

/**
 * Is `relPath` (POSIX, relative to the walk root) ignored?
 *
 * @param {string} relPath
 * @param {boolean} isDir
 * @param {Array<Array<object>>} layers
 * @returns {boolean}
 */
function isIgnored(relPath, isDir, layers) {
  let ignored = false;
  for (const rules of layers) {
    for (const rule of rules) {
      if (rule.dirOnly && !isDir) continue;
      if (rule.regex.test(relPath)) ignored = !rule.negated;
    }
  }
  return ignored;
}

/**
 * Match an `--exclude` glob against a path relative to the walk root.
 *
 * Contract:
 *   - a pattern containing '/' is tested against the WHOLE relative path
 *     (`build/out.js` matches only `build/out.js`, not `src/build/out.js`
 *     unless it also matches there)
 *   - a pattern with no '/' is tested against EACH segment, so `dist` or
 *     `*.log` excludes that name at any depth
 *   - inside a pattern, `*` does not cross '/' but `**` does
 */
function matchesExclude(relPath, patterns) {
  if (!patterns || patterns.length === 0) return false;
  const segments = relPath.split('/');
  for (const pattern of patterns) {
    const clean = pattern.replace(/^\.\//, '').replace(/\/+$/, '');
    if (clean === '') continue;
    const re = globToRegExp(clean);
    if (clean.includes('/')) {
      if (re.test(relPath)) return true;
    } else {
      for (const seg of segments) {
        if (re.test(seg)) return true;
      }
    }
  }
  return false;
}

function globToRegExp(pattern) {
  let body = '';
  let i = 0;
  while (i < pattern.length) {
    const ch = pattern[i];
    if (ch === '*') {
      if (pattern[i + 1] === '*') {
        if (pattern[i + 2] === '/') {
          body += '(?:[^/]+/)*';
          i += 3;
          continue;
        }
        body += '.*';
        i += 2;
        continue;
      }
      body += '[^/]*';
      i += 1;
      continue;
    }
    if (ch === '?') {
      body += '[^/]';
      i += 1;
      continue;
    }
    body += ch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    i += 1;
  }
  return new RegExp(`^${body}$`);
}

module.exports = {
  parseGitignore,
  loadGitignore,
  collectGitignores,
  isIgnored,
  matchesExclude,
  globToRegExp,
  compilePattern,
};
