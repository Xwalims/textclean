'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { walk, extensionOf, toPosix } = require('../src/walk.js');
const { parseGitignore, matchesExclude, globToRegExp } = require('../src/gitignore.js');

/** Build a throwaway tree, run fn, then remove it. */
function withTree(files, fn) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'textclean-walk-'));
  for (const [rel, content] of Object.entries(files)) {
    const full = path.join(root, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
  }
  try {
    return fn(root);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

const rel = (root) => (p) => toPosix(path.relative(root, p));

test('walk finds files recursively', () => {
  withTree({ 'a.txt': 'a', 'sub/b.txt': 'b', 'sub/deep/c.txt': 'c' }, (root) => {
    const found = walk(root).map(rel(root)).sort();
    assert.deepEqual(found, ['a.txt', 'sub/b.txt', 'sub/deep/c.txt']);
  });
});

test('walk skips .git and node_modules unconditionally', () => {
  withTree({
    'keep.txt': 'x',
    '.git/config': 'x',
    'node_modules/pkg/index.js': 'x',
  }, (root) => {
    const found = walk(root).map(rel(root));
    assert.deepEqual(found, ['keep.txt']);
  });
});

test('walk skips .git and node_modules even when they are not ignored by gitignore', () => {
  withTree({ '.git/a': 'x', 'node_modules/b': 'y', 'c.txt': 'z' }, (root) => {
    assert.deepEqual(walk(root).map(rel(root)), ['c.txt']);
  });
});

test('walk honours --exclude globs', () => {
  withTree({
    'keep.js': 'x',
    'skip.js': 'x',
    'build/out.js': 'x',
  }, (root) => {
    const found = walk(root, { exclude: ['skip.js', 'build'] }).map(rel(root));
    assert.deepEqual(found, ['keep.js']);
  });
});

test('a bare --exclude pattern matches any segment at any depth', () => {
  withTree({ 'a.js': 'x', 'sub/a.js': 'y' }, (root) => {
    // Documented contract: a pattern with no '/' is tested against every path
    // segment, so '*.js' removes both. Use '*/*.js'-style or a literal path
    // when only one depth should match.
    const found = walk(root, { exclude: ['*.js'] }).map(rel(root));
    assert.deepEqual(found, []);
  });
});

test('a --exclude pattern containing a slash is matched against the whole path', () => {
  withTree({ 'sub/a.js': 'y', 'a.js': 'x' }, (root) => {
    // 'sub/a.js' names a path, not a bare segment, so the top-level a.js stays.
    const found = walk(root, { exclude: ['sub/a.js'] }).map(rel(root));
    assert.deepEqual(found, ['a.js']);
  });
});

test('a bare --exclude name does not match a longer segment name', () => {
  withTree({ 'district/c.js': 'y', 'dist/c.js': 'x' }, (root) => {
    const found = walk(root, { exclude: ['dist'] }).map(rel(root));
    assert.deepEqual(found, ['district/c.js']);
  });
});

test('** crosses directories in an exclude pattern', () => {
  withTree({ 'a.js': 'x', 'sub/a.js': 'y', 'sub/deep/a.js': 'z' }, (root) => {
    const found = walk(root, { exclude: ['**/a.js'] }).map(rel(root));
    assert.deepEqual(found, []);
  });
});

test('walk honours --ext filtering', () => {
  withTree({ 'a.js': 'x', 'b.md': 'y', 'c.txt': 'z' }, (root) => {
    const found = walk(root, { ext: ['.js', '.md'] }).map(rel(root));
    assert.deepEqual(found, ['a.js', 'b.md']);
  });
});

test('walk honours a root .gitignore by default', () => {
  withTree({
    '.gitignore': 'ignored.txt\n',
    'ignored.txt': 'x',
    'kept.txt': 'y',
  }, (root) => {
    const found = walk(root).map(rel(root));
    assert.deepEqual(found, ['.gitignore', 'kept.txt']);
  });
});

test('--no-gitignore disables .gitignore handling', () => {
  withTree({ '.gitignore': 'ignored.txt\n', 'ignored.txt': 'x' }, (root) => {
    const found = walk(root, { gitignore: false }).map(rel(root));
    assert.deepEqual(found, ['.gitignore', 'ignored.txt']);
  });
});

test('a directory-only gitignore pattern ignores the whole tree', () => {
  withTree({
    '.gitignore': 'dist/\n',
    'dist/a.js': 'x',
    'src/b.js': 'y',
  }, (root) => {
    const found = walk(root).map(rel(root));
    assert.deepEqual(found, ['.gitignore', 'src/b.js']);
  });
});

test('a gitignore negation re-includes a file', () => {
  withTree({
    '.gitignore': '*.log\n!keep.log\n',
    'drop.log': 'x',
    'keep.log': 'y',
  }, (root) => {
    const found = walk(root).map(rel(root));
    assert.deepEqual(found, ['.gitignore', 'keep.log']);
  });
});

test('comments and blank lines in .gitignore are ignored', () => {
  withTree({ '.gitignore': '# a comment\n\n   \nreal.txt\n', 'real.txt': 'x' }, (root) => {
    assert.deepEqual(walk(root).map(rel(root)), ['.gitignore']);
  });
});

test('an anchored gitignore pattern only matches at the root', () => {
  withTree({ '.gitignore': '/only-root.txt\n', 'only-root.txt': 'x', 'sub/only-root.txt': 'y' }, (root) => {
    const found = walk(root).map(rel(root));
    assert.ok(found.includes('only-root.txt') === false);
    assert.ok(found.includes('sub/only-root.txt'));
  });
});

test('a bare gitignore name matches at any depth', () => {
  withTree({ '.gitignore': 'dup.txt\n', 'dup.txt': 'x', 'a/dup.txt': 'y' }, (root) => {
    const found = walk(root).map(rel(root));
    assert.deepEqual(found, ['.gitignore']);
  });
});

test('walk on a single file returns that file', () => {
  withTree({ 'a.txt': 'x' }, (root) => {
    const found = walk(path.join(root, 'a.txt'));
    assert.equal(found.length, 1);
    assert.equal(path.basename(found[0]), 'a.txt');
  });
});

test('walk results are sorted for reproducible output', () => {
  withTree({ 'z.txt': 'x', 'a.txt': 'y', 'm.txt': 'z' }, (root) => {
    const found = walk(root).map(rel(root));
    assert.deepEqual(found, ['a.txt', 'm.txt', 'z.txt']);
  });
});

test('walk does not follow symlinks by default', () => {
  withTree({ 'real/a.txt': 'x' }, (root) => {
    fs.symlinkSync(path.join(root, 'real'), path.join(root, 'link'));
    const found = walk(root).map(rel(root));
    assert.ok(!found.some((f) => f.startsWith('link/')), 'symlinked dir was not descended');
  });
});

test('--follow-symlinks descends through a symlinked directory', () => {
  withTree({ 'real/a.txt': 'x' }, (root) => {
    fs.symlinkSync(path.join(root, 'real'), path.join(root, 'link'));
    const found = walk(root, { followSymlinks: true }).map(rel(root));
    assert.ok(found.some((f) => f.startsWith('link/')), 'symlinked dir was descended');
  });
});

// --- unit-level matcher behaviour -----------------------------------------

test('extensionOf normalises case and handles dotfiles', () => {
  assert.equal(extensionOf('a.MD'), '.md');
  assert.equal(extensionOf('a.tar.gz'), '.gz');
  assert.equal(extensionOf('Makefile'), '');
  assert.equal(extensionOf('.gitignore'), '');
});

test('toPosix converts platform separators', () => {
  assert.equal(toPosix(path.join('a', 'b')), 'a/b');
});

test('parseGitignore compiles comments out', () => {
  const rules = parseGitignore('# nope\n*.js\n');
  assert.equal(rules.length, 1);
  assert.equal(rules[0].negated, false);
});

test('matchesExclude: a bare name matches a segment at any depth', () => {
  assert.equal(matchesExclude('a/b/dist/c.js', ['dist']), true);
  assert.equal(matchesExclude('dist/c.js', ['dist']), true);
  assert.equal(matchesExclude('a/district/c.js', ['dist']), false);
});

test('globToRegExp: * does not cross a slash but ** does', () => {
  assert.equal(globToRegExp('*.js').test('a/b.js'), false);
  assert.equal(globToRegExp('*.js').test('b.js'), true);
  assert.equal(globToRegExp('**/b.js').test('a/x/b.js'), true);
});

test('gitignore character classes are supported', () => {
  const rules = parseGitignore('file[12].txt\n');
  assert.equal(rules[0].regex.test('file1.txt'), true);
  assert.equal(rules[0].regex.test('file2.txt'), true);
  assert.equal(rules[0].regex.test('file3.txt'), false);
});
