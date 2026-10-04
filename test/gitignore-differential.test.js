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
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { walk } = require('../src/walk.js');

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

test('git is actually available, otherwise every case above is vacuous', () => {
  const out = execFileSync('git', ['--version'], { encoding: 'utf8' });
  assert.match(out, /git version/);
});
