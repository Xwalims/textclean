'use strict';

const fs = require('node:fs');
const path = require('node:path');

const { collectGitignores, isIgnored, matchesExclude } = require('./gitignore.js');

/**
 * Recursive directory walk.
 *
 * Contract, stated plainly because it is smaller than git's:
 *   - `.git` and `node_modules` are ALWAYS skipped, unconditionally.
 *   - `--exclude` takes glob patterns; `*` does not cross `/`, `**` does, and a
 *     pattern with no slash matches any single path segment at any depth.
 *   - `--no-gitignore` disables .gitignore handling. When enabled (default),
 *     a root `.gitignore` plus any nested ones are read; see README for the
 *     exact subset of gitignore syntax that is honoured.
 *   - symlinks are NOT followed unless `--follow-symlinks`, which prevents
 *     directory cycles from hanging the process.
 *   - results are sorted for reproducible output.
 */

/**
 * @typedef {object} WalkOptions
 * @property {string[]} [exclude]
 * @property {string[]|null} [ext]
 * @property {boolean} [gitignore]
 * @property {string[]} [alwaysSkipDirs]
 * @property {boolean} [followSymlinks]
 */

/**
 * @param {string} root
 * @param {WalkOptions} [options]
 * @returns {string[]} absolute paths of candidate files
 */
function walk(root, options = {}) {
  const {
    exclude = [],
    ext = null,
    gitignore = true,
    alwaysSkipDirs = ['.git', 'node_modules'],
    followSymlinks = false,
  } = options;

  const absRoot = path.resolve(root);
  const stats = fs.statSync(absRoot);
  if (!stats.isDirectory()) return filterFile(absRoot, ext);

  const layers = gitignore ? collectGitignores(absRoot) : [];
  const skip = new Set(alwaysSkipDirs);
  const results = [];

  const visit = (dir) => {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return; // unreadable directory: skip rather than abort the whole walk
    }
    // Sort so output order is stable across platforms and filesystems.
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      const rel = toPosix(path.relative(absRoot, full));

      let isDir = entry.isDirectory();
      let isFile = entry.isFile();
      let isSymlink = entry.isSymbolicLink();

      if (isSymlink && followSymlinks) {
        try {
          const st = fs.statSync(full);
          isDir = st.isDirectory();
          isFile = st.isFile();
          isSymlink = false;
        } catch {
          continue; // broken symlink
        }
      } else if (isSymlink) {
        continue;
      }

      if (isDir) {
        if (skip.has(entry.name)) continue;
        if (matchesExclude(rel, exclude)) continue;
        if (gitignore && isIgnored(rel, true, layers)) continue;
        visit(full);
        continue;
      }

      if (!isFile) continue;
      if (matchesExclude(rel, exclude)) continue;
      if (gitignore && isIgnored(rel, false, layers)) continue;
      if (ext && !ext.includes(extensionOf(entry.name))) continue;
      results.push(full);
    }
  };

  visit(absRoot);
  results.sort();
  return results;
}

function filterFile(absRoot, ext) {
  if (ext && !ext.includes(extensionOf(absRoot))) return [];
  return [absRoot];
}

function extensionOf(name) {
  const dot = name.lastIndexOf('.');
  if (dot <= 0) return '';
  return name.slice(dot).toLowerCase();
}

function toPosix(p) {
  return p.split(path.sep).join('/');
}

module.exports = { walk, extensionOf, toPosix };
