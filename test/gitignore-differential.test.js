'use strict';

/**
 * Differential test: nested `.gitignore` handling must agree with REAL git.
 *
 * The unit tests in walk.test.js encode this project's reading of gitignore.
 * That reading was wrong. `loadGitignore` computed the directory a nested
 * ignore file's patterns are relative to as `path.relative(dir, dir)` -- the
 * empty string, always -- so a rule in `sub/.gitignore` was compiled with no
 * prefix and applied tree-wide. `compilePattern` then made even a correctly
 * supplied prefix optional (`^(?:sub/)?`), which leaked in the other
 * direction. Between them, no nested case matched git: a `sub/.gitignore`
 * containing `secret.txt` ignored the repository's own top-level
 * `secret.txt`, while a nested `/only.txt` matched nothing at all.
 *
 * So the expectations here come from `git check-ignore`, not from the code.
 * The pure-logic tests stay where they are; this file is what makes them
 * honest.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { walk } = require('../src/walk.js');
const { parseGitignore } = require('../src/gitignore.js');

/**
 * Build a throwaway repository and ask git what it ignores.
 *
 * @param {Record<string, string>} files tree contents, paths are POSIX
 * @returns {{truth: Record<string, boolean>, processed: Set<string>}}
 *   `truth[p]` is true when git ignores `p`; `processed` holds the paths
 *   textclean would act on.
 */
function compareWithGit(files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'textclean-git-diff-'));
  try {
    for (const [rel, content] of Object.entries(files)) {
      const full = path.join(root, rel);
      fs.mkdirSync(path.dirname(full), { recursive: true });
      fs.writeFileSync(full, content);
    }

    const run = (args) =>
      execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    run(['init', '-q']);
    run(['config', 'user.email', 'test@example.invalid']);
    run(['config', 'user.name', 'test']);

    const truth = {};
    for (const rel of Object.keys(files)) {
      try {
        run(['check-ignore', '-q', '--', rel]);
        truth[rel] = true;
      } catch {
        truth[rel] = false;
      }
    }

    const processed = new Set(
      walk(root).map((f) => path.relative(root, f).split(path.sep).join('/')),
    );
    return { truth, processed };
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

/** Every scenario below is checked against git, not against this project. */
const CASES = [
  {
    name: 'a nested bare name does not leak outside its own directory',
    // git keeps the top-level copies; textclean used to ignore them.
    files: {
      'sub/.gitignore': 'secret.txt\n',
      'secret.txt': 'x',
      'other/secret.txt': 'x',
      'sub/secret.txt': 'x',
      'sub/deep/secret.txt': 'x',
    },
    ignored: ['sub/secret.txt', 'sub/deep/secret.txt'],
  },
  {
    name: 'a nested anchored pattern matches only under its own directory',
    files: {
      'sub/.gitignore': '/only.txt\n',
      'only.txt': 'x',
      'sub/only.txt': 'x',
      'sub/deep/only.txt': 'x',
    },
    ignored: ['sub/only.txt'],
  },
  {
    name: 'a nested glob reaches only its own subtree',
    files: {
      'sub/.gitignore': '*.tmp\n',
      'a.tmp': 'x',
      'sub/a.tmp': 'x',
      'sub/deep/a.tmp': 'x',
    },
    ignored: ['sub/a.tmp', 'sub/deep/a.tmp'],
  },
  {
    name: 'a nested negation re-includes inside its own directory only',
    files: {
      'sub/.gitignore': '*.tmp\n!keep.tmp\n',
      'a.tmp': 'x',
      'sub/a.tmp': 'x',
      'sub/keep.tmp': 'x',
      'sub/deep/keep.tmp': 'x',
    },
    ignored: ['sub/a.tmp'],
  },
  {
    name: 'a rule in a deeply nested file scopes to that directory',
    files: {
      'sub/deep/.gitignore': 'x.txt\n',
      'x.txt': 'x',
      'sub/x.txt': 'x',
      'sub/deep/x.txt': 'x',
      'sub/deep/deeper/x.txt': 'x',
    },
    ignored: ['sub/deep/x.txt', 'sub/deep/deeper/x.txt'],
  },
  {
    name: 'a nested directory-only rule ignores the subtree, not a sibling of the name',
    files: {
      'sub/.gitignore': 'cache/\n',
      'cache/a.txt': 'x',
      'sub/cache/a.txt': 'x',
      'sub/cache/b/c.txt': 'x',
    },
    ignored: ['sub/cache/a.txt', 'sub/cache/b/c.txt'],
  },
  {
    name: 'a deeper ignore file overrides a shallower one on a shared path',
    files: {
      '.gitignore': '*.log\n',
      'sub/.gitignore': 'keep.log\n',
      'keep.log': 'x',
      'sub/keep.log': 'x',
      'sub/other.log': 'x',
    },
    ignored: ['keep.log', 'sub/keep.log', 'sub/other.log'],
  },
  {
    name: 'a nested pattern containing a slash is relative to its own directory',
    files: {
      'sub/.gitignore': 'out/dist.js\n',
      'sub/out/dist.js': 'x',
      'out/dist.js': 'x',
      'other/sub/out/dist.js': 'x',
    },
    ignored: ['sub/out/dist.js'],
  },
  {
    name: 'git: a negation cannot revive a file under an excluded parent directory',
    files: {
      '.gitignore': 'logs/\n',
      'logs/.gitignore': '!keep.txt\n',
      'logs/keep.txt': 'x',
      'logs/other.txt': 'x',
    },
    ignored: ['logs/keep.txt', 'logs/other.txt'],
  },
  {
    name: 'git: build/* excludes a nested file but !build/keep.txt still works',
    files: {
      '.gitignore': 'build/*\n!build/keep.txt\n',
      'build/x.txt': 'x',
      'build/a/b.txt': 'x',
      'build/keep.txt': 'x',
    },
    ignored: ['build/x.txt', 'build/a/b.txt'],
  },
];

for (const { name, files, ignored } of CASES) {
  test(`agrees with git: ${name}`, () => {
    const { truth, processed } = compareWithGit(files);

    // The scenario's own claim has to match git, or the case is worthless.
    // Only the payload paths are claimed: a `.gitignore` file can itself be
    // ignored by a rule in a parent file (`logs/` ignores `logs/.gitignore`),
    // and that is git being right, not a broken expectation.
    for (const rel of Object.keys(files).filter((f) => !f.endsWith('.gitignore'))) {
      assert.equal(
        truth[rel],
        ignored.includes(rel),
        `scenario setup disagrees with git for ${JSON.stringify(rel)}: ` +
          `git says ${truth[rel] ? 'ignored' : 'kept'}`,
      );
    }

    for (const rel of Object.keys(files)) {
      assert.equal(
        processed.has(rel),
        !truth[rel],
        `${JSON.stringify(rel)}: git ${truth[rel] ? 'ignores' : 'keeps'} it, ` +
          `textclean ${processed.has(rel) ? 'keeps' : 'ignores'} it`,
      );
    }
  });
}

/**
 * Character-class cases, checked against real git for the same reason as
 * CASES above: the previous class compiler pasted the raw interior between
 * brackets, so every expectation in walk.test.js was the project's own reading.
 *
 * These are assertions about behaviour that must hold; they are not
 * reproductions of the old crash, which was an exception rather than a verdict.
 * Each case lists the single characters git matches, measured with
 * `git check-ignore` over files named for every printable ASCII character.
 */
const CLASS_CASES = [
  // A leading `]` is a literal member, not the terminator. The old compiler
  // stopped at it and produced the empty class `[]`, which matches nothing.
  { pattern: '[]a]', matches: [']', 'a'], misses: ['b'] },
  { pattern: '[]]', matches: [']'], misses: ['a'] },
  { pattern: '[]-]', matches: [']', '-'], misses: ['a'] },

  // A `-` at either end is a literal.
  { pattern: '[a-]', matches: ['a', '-'], misses: ['b'] },
  { pattern: '[-a]', matches: ['a', '-'], misses: ['b'] },
  { pattern: '[a\\-c]', matches: ['a', '-', 'c'], misses: ['b'] },

  // A reversed range keeps its low endpoint alone. git neither rejects it nor
  // reads it as the literal run `b`, `-`, `a`.
  { pattern: '[b-a]', matches: ['b'], misses: ['a', 'c'] },
  { pattern: '[c-b]', matches: ['c'], misses: ['b', 'd'] },

  // Escapes inside a class escape the next character.
  { pattern: '[\\]]', matches: [']'], misses: ['a'] },
  { pattern: '[\\a]', matches: ['a'], misses: ['b'] },
  { pattern: '[a\\b]', matches: ['a', 'b'], misses: ['c'] },

  // An unterminated class is literal text and matches nothing here.
  { pattern: '[a', matches: [], misses: ['a', 'b'] },

  // A class never matches the path separator, even when it contains one.
  // A range that spans the slash keeps its other members.
  { pattern: '[--/]', matches: ['-'], misses: ['a', '0'] },
  { pattern: '[+-0]', matches: ['+', ',', '-', '.', '0'], misses: ['1', 'a'] },
  { pattern: '[/0]', matches: ['0'], misses: ['-', '.'] },
];

/**
 * Create a throwaway repo with one gitignore line and the given files, and
 * return git's verdict as a Set of matched names.
 */
function truthFor(names, pattern) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'textclean-class-'));
  const git = (args) =>
    execFileSync('git', args, { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  try {
    fs.writeFileSync(path.join(dir, '.gitignore'), pattern + '\n');
    for (const n of names) {
      const full = path.join(dir, n);
      if (fs.existsSync(full)) continue;
      fs.mkdirSync(path.dirname(full), { recursive: true });
      fs.writeFileSync(full, 'x');
    }
    // Ask git only about names that are real FILES on disk. `.` resolves to
    // the repository root and `/` is rejected as outside it, and check-ignore
    // answers about the PATH rather than the string -- so either one silently
    // yields a verdict about a directory, not about the character under test.
    const askable = names.filter((n) => {
      const st = fs.statSync(path.join(dir, n), { throwIfNoEntry: false });
      return Boolean(st && st.isFile());
    });
    git(['init', '-q']);
    git(['config', 'user.email', 'test@example.invalid']);
    git(['config', 'user.name', 'test']);
    // check-ignore exits 1 when nothing matched, which is a verdict, not a
    // failure -- so spawnSync rather than execFileSync, which would throw.
    const res = spawnSync('git', ['check-ignore', '-z', '--stdin'], {
      cwd: dir,
      input: askable.join('\0') + '\0',
      encoding: 'utf8',
    });
    if (res.status !== 0 && res.status !== 1) {
      throw new Error(`git check-ignore failed (${res.status}): ${res.stderr}`);
    }
    return { dir, out: res.stdout || '', askable };
  } catch (e) {
    fs.rmSync(dir, { recursive: true, force: true });
    throw e;
  }
}

test('character classes agree with git', () => {
  const wanted = new Set(CLASS_CASES.flatMap((c) => c.matches));
  const unwanted = new Set(CLASS_CASES.flatMap((c) => c.misses));
  const names = [...new Set([...wanted, ...unwanted])];

  for (const c of CLASS_CASES) {
    // One repo per case, because the patterns would otherwise interact.
    const { dir, out, askable } = truthFor(names, c.pattern);
    try {
      const truth = new Set(out.split('\0').filter(Boolean));
      const rules = parseGitignore(c.pattern, '');
      assert.equal(rules.length, 1, `${c.pattern}: expected one rule`);
      for (const n of askable) {
        const expected = truth.has(n);
        const actual = rules[0].regex.test(n);
        assert.equal(
          actual,
          expected,
          `${c.pattern} vs ${JSON.stringify(n)}: git ${expected ? 'matches' : 'does not match'}, ` +
            `textclean ${actual ? 'matches' : 'does not match'}`,
        );
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
});

test('a slash inside a class never matches a path separator', () => {
  for (const [pattern, path_, shouldMatch] of [
    ['[a/b]', 'b', true],       // anchored by the slash inside the class
    ['[a/b]', 'a/b', false],    // ... but the class itself still cannot match one
    ['[a/]b', 'ab', true],      // the slash is dropped, leaving `ab`
    ['[a/]b', 'a/b', false],
    ['[/]', 'a/b', false],      // a class of nothing but a slash matches nothing
  ]) {
    const rules = parseGitignore(pattern, '');
    assert.equal(rules.length, 1, `${pattern}: expected one rule`);
    assert.equal(
      rules[0].regex.test(path_),
      shouldMatch,
      `${pattern} vs ${JSON.stringify(path_)}: expected ${shouldMatch ? 'a match' : 'no match'}`,
    );
  }
});

test('no gitignore pattern can produce an invalid RegExp', () => {
  // The old compiler pasted the class interior between brackets, so an escaped
  // `]` closed the class early and left the fragment unterminated. These all
  // reached `new RegExp` and threw, from the CLI, on any `.gitignore` containing
  // one of them.
  for (const pattern of [
    '[a\\]', '[\\]]', '[\\]', '[]a]', '[a\\b]', '[]-]', '[!a\\]',
    '[\\--c]', '[--/]', '[+-0]', '[/]', '[]', '[]a', '[!]', '[^]',
  ]) {
    const rules = parseGitignore(pattern, '');
    assert.ok(Array.isArray(rules), `${pattern}: expected an array`);
    for (const rule of rules) {
      assert.ok(rule.regex instanceof RegExp, `${pattern}: no RegExp`);
    }
  }
});

test('a globstar is any run of two or more asterisks', () => {
  // git treats `***` exactly as `**`. The old compiler consumed only the first
  // two asterisks and let the rest fall through to the single-star branch, so
  // `***/**` compiled to something that demanded a slash and so matched nothing
  // at the top level.
  const probes = ['a.txt', 'd/b.txt', 'd/e/c.txt'];
  for (const pattern of ['***/**', '****/**', '***', '**']) {
    const { dir, out } = truthFor(probes, pattern);
    try {
      const truth = new Set(out.split('\0').filter(Boolean));
      const rules = parseGitignore(pattern, '');
      for (const p of probes) {
        const actual = rules.some((r) => r.regex.test(p));
        assert.equal(
          actual,
          truth.has(p),
          `${pattern} vs ${p}: git ${truth.has(p) ? 'ignores' : 'keeps'} it`,
        );
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
});

test('git is actually available, otherwise every case above is vacuous', () => {
  const out = execFileSync('git', ['--version'], { encoding: 'utf8' });
  assert.match(out, /git version/);
});
