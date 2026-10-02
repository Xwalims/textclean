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
 *
 * WHAT IS NOT SUPPORTED (and is not claimed anywhere):
 *   - regex character-class edge cases beyond a plain class
 *   - `\` line continuations
 *   - per-directory .gitignore nesting is honoured for path matching, but a
 *     nested ignore file's patterns are resolved relative to its directory and
 *     applied to the full path — equivalent to git for the common cases
 *   - git's "patterns from a deeper file override a shallower one" precedence,
 *     beyond plain last-match-wins within one file
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
  const prefix = gitignoreDir ? gitignoreDir.split('/').filter(Boolean) : [];

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
  const prefixRe = prefix.length ? `^(?:${prefix.map(escapeRe).join('/')}/)?` : '^';
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
 * @returns {Array<{negated: boolean, dirOnly: boolean, regex: RegExp}>}
 */
function loadGitignore(dir, file = '.gitignore') {
  const full = path.join(dir, file);
  let raw;
  try {
    raw = fs.readFileSync(full, 'utf8');
  } catch {
    return [];
  }
  // Patterns in a root .gitignore are unanchored; path.relative of a dir to
  // itself is '', which is exactly the anchor we want.
  const relDir = path.relative(path.resolve(dir), path.resolve(dir));
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
  const layers = [];
  const rootIgnore = loadGitignore(root);
  if (rootIgnore.length) layers.push(rootIgnore);
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
      const rules = loadGitignore(child);
      if (rules.length) layers.push(rules);
      stack.push(child);
    }
  }
  return layers;
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
