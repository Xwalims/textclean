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
 *   - regex character-class edge cases beyond a plain class
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

  // Decide anchoring BEFORE compiling, then drop the leading '/'. Compiling
  // first would bake the '/' into the body and produce a regex like '^^/name$'
  // that can never match a relative path — every anchored pattern would
  // silently stop working.
  const anchored = pattern.startsWith('/') || pattern.slice(0, -1).includes('/');
  pattern = pattern.replace(/^\/+/, '');
  if (pattern === '') return null;

  // Patterns from a nested .gitignore resolve relative to its own directory.
  const prefix = gitignoreDir ? String(gitignoreDir).split('/').filter(Boolean) : [];

  let body = '';
  let i = 0;
  while (i < pattern.length) {
    const ch = pattern[i];
    if (ch === '*') {
      if (pattern[i + 1] === '*') {
        // `**/` -> any number of directories; trailing `/**` -> everything below.
        if (pattern[i + 2] === '/') {
          body += '(?:.*/)?';
          i += 3;
          continue;
        }
        if (i + 2 === pattern.length) {
          body += '.*';
          i += 2;
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
    if (ch === '[') {
      const close = pattern.indexOf(']', i + 1);
      if (close !== -1) {
        let cls = pattern.slice(i + 1, close);
        if (cls.startsWith('!')) cls = `^${cls.slice(1)}`;
        body += `[${cls}]`;
        i = close + 1;
        continue;
      }
      body += '\\[';
      i += 1;
      continue;
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
    const line = rawLine.replace(/\r$/, '').trimEnd();
    if (line === '' || line.startsWith('#')) continue;
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
