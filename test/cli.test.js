'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const { parseArgs, VERSION, USAGE } = require('../src/cli.js');
const { writeFileAtomic, inspectFile, analyzeFile } = require('../src/fileops.js');
const { DEFAULTS } = require('../src/options.js');

const ROOT = path.resolve(__dirname, '..');
const BIN = path.join(ROOT, 'bin', 'textclean.js');
const hex = (s) => Buffer.from(s, 'utf8').toString('hex');

/** Create a temp dir populated with `files`, run fn, always clean up. */
function withTree(files, fn) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'textclean-cli-'));
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

/** Run the real bin. Returns {status, stdout, stderr}. */
function runBin(args, cwd) {
  const r = spawnSync(process.execPath, [BIN, ...args], {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, NO_COLOR: '1' },
  });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

// ---------------------------------------------------------------------------
// Argument parsing.
// ---------------------------------------------------------------------------

test('parseArgs: defaults are safe — nothing is written without --write', () => {
  const { options } = parseArgs(['a.txt']);
  assert.equal(options.write, false);
  assert.equal(options.check, false);
  assert.equal(options.eol, 'keep');
});

test('parseArgs: collects paths and flags', () => {
  const { paths, options } = parseArgs(['a', 'b', '--eol', 'lf', '--strip-bom']);
  assert.deepEqual(paths, ['a', 'b']);
  assert.equal(options.eol, 'lf');
  assert.equal(options.stripBom, true);
});

test('parseArgs: --flag=value form is accepted', () => {
  const { options } = parseArgs(['--eol=crlf', '--tabs-to-spaces=8']);
  assert.equal(options.eol, 'crlf');
  assert.equal(options.tabsToSpaces, 8);
});

test('parseArgs: --in-place is an alias for --write', () => {
  assert.equal(parseArgs(['--in-place']).options.write, true);
});

test('parseArgs: comma-separated lists are split', () => {
  const { options } = parseArgs(['--ext', '.js,.md', '--exclude', 'a,b']);
  assert.deepEqual(options.ext, ['.js', '.md']);
  assert.deepEqual(options.exclude, ['a', 'b']);
});

test('parseArgs: extensions given without a dot are normalised', () => {
  assert.deepEqual(parseArgs(['--ext', 'js']).options.ext, ['.js']);
});

test('parseArgs: --ext may be repeated', () => {
  assert.deepEqual(parseArgs(['--ext', '.js', '--ext', '.md']).options.ext, ['.js', '.md']);
});

test('parseArgs: --no-gitignore turns the option off', () => {
  assert.equal(parseArgs(['--no-gitignore']).options.gitignore, false);
  assert.equal(parseArgs([]).options.gitignore, true);
});

test('parseArgs: an unknown option is a usage error', () => {
  assert.throws(() => parseArgs(['--nope']), /unknown option --nope/);
});

test('parseArgs: a value flag with no value is a usage error', () => {
  assert.throws(() => parseArgs(['--eol']), /--eol needs a value/);
});

test('parseArgs: an invalid eol value is rejected', () => {
  assert.throws(() => parseArgs(['--eol', 'wat']), /--eol must be one of/);
});

test('parseArgs: a non-integer numeric value is rejected', () => {
  assert.throws(() => parseArgs(['--tabs-to-spaces', 'wide']), /needs an integer/);
});

test('parseArgs: --ensure-crlf contradicting --eol is rejected', () => {
  assert.throws(() => parseArgs(['--ensure-crlf', '--eol', 'lf']), /contradicts/);
});

test('parseArgs: contradictory final-newline flags are rejected', () => {
  assert.throws(
    () => parseArgs(['--ensure-final-newline', '--no-final-newline']),
    /contradict/,
  );
});

test('parseArgs: everything after -- is treated as a path', () => {
  const { paths } = parseArgs(['--eol', 'lf', '--', '--weird-name.txt']);
  assert.deepEqual(paths, ['--weird-name.txt']);
});

test('DEFAULTS is frozen and carries no duplicates', () => {
  assert.ok(Object.isFrozen(DEFAULTS));
  assert.equal(DEFAULTS.eol, 'keep');
  assert.equal(DEFAULTS.stripBom, false);
});

// ---------------------------------------------------------------------------
// End-to-end: the real bin, the real exit codes.
// ---------------------------------------------------------------------------

test('e2e: --write rewrites BOM + CRLF + trailing whitespace, real bytes asserted', () => {
  withTree({ 'dirty.txt': '\uFEFFalpha  \r\nbeta\r\n' }, (root) => {
    const file = path.join(root, 'dirty.txt');
    const beforeBytes = fs.readFileSync(file);
    assert.equal(beforeBytes.toString('hex'), 'efbbbf' + hex('alpha  \r\nbeta\r\n'), 'fixture bytes');

    const r = runBin([
      '--write', '--eol', 'lf', '--strip-bom', '--strip-trailing-whitespace', 'dirty.txt',
    ], root);

    assert.equal(r.status, 0, `expected exit 0, got ${r.status}: ${r.stderr}`);
    const after = fs.readFileSync(file);
    assert.equal(after.toString('hex'), hex('alpha\nbeta\n'), 'exact expected bytes on disk');
  });
});

test('e2e: a lone CR is a line terminator, so its blank line survives conversion', () => {
  // 'beta\r\r\n' is line "beta" ended by CR, then an EMPTY line ended by CRLF.
  // Line structure is preserved, so the result keeps a trailing blank line.
  withTree({ 't.txt': '\uFEFFalpha  \r\nbeta\r\r\n' }, (root) => {
    const r = runBin(['--write', '--eol', 'lf', '--strip-bom', '--strip-trailing-whitespace', 't.txt'], root);
    assert.equal(r.status, 0);
    assert.equal(fs.readFileSync(path.join(root, 't.txt')).toString('hex'), hex('alpha\nbeta\n\n'));
  });
});

test('e2e: without --write the file is NOT modified', () => {
  withTree({ 'dirty.txt': 'alpha  \r\n' }, (root) => {
    const file = path.join(root, 'dirty.txt');
    const original = fs.readFileSync(file);

    const r = runBin(['--eol', 'lf', '--strip-trailing-whitespace', 'dirty.txt'], root);

    assert.equal(r.status, 0);
    assert.ok(r.stdout.includes('would fix'), 'it reports the change');
    assert.ok(fs.readFileSync(file).equals(original), 'but the bytes on disk are untouched');
  });
});

test('e2e: --check exits 1 when a file would change', () => {
  withTree({ 'dirty.txt': 'alpha  \n' }, (root) => {
    const r = runBin(['--check', '--strip-trailing-whitespace', 'dirty.txt'], root);
    assert.equal(r.status, 1);
    assert.ok(r.stdout.includes('check failed'));
  });
});

test('e2e: --check exits 0 when everything is already clean', () => {
  withTree({ 'clean.txt': 'alpha\nbeta\n' }, (root) => {
    const r = runBin(['--check', '--strip-trailing-whitespace', '--eol', 'lf', 'clean.txt'], root);
    assert.equal(r.status, 0, r.stdout);
  });
});

test('e2e: --check exits 1 with no transformation flags when CRLF is present', () => {
  withTree({ 'crlf.txt': 'a\r\nb\r\n' }, (root) => {
    const r = runBin(['--check', '--eol', 'lf', 'crlf.txt'], root);
    assert.equal(r.status, 1);
  });
});

test('e2e: a binary file is skipped and never mangled', () => {
  const payload = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01, 0x02]);
  withTree({ 'image.bin': payload }, (root) => {
    const file = path.join(root, 'image.bin');
    const r = runBin(['--write', '--eol', 'lf', '--strip-trailing-whitespace', '.'], root);
    assert.equal(r.status, 0);
    assert.ok(fs.readFileSync(file).equals(payload), 'binary bytes are untouched');
    assert.ok(r.stdout.includes('binary'), 'it says why it skipped');
  });
});

test('e2e: a UTF-16 file is reported as unsupported and left alone', () => {
  const payload = Buffer.concat([
    Buffer.from([0xff, 0xfe]),
    Buffer.from('hi  \r\n', 'utf16le'),
  ]);
  withTree({ 'u16.txt': payload }, (root) => {
    const file = path.join(root, 'u16.txt');
    const r = runBin(['--write', '--eol', 'lf', 'u16.txt'], root);
    assert.equal(r.status, 0);
    assert.ok(fs.readFileSync(file).equals(payload), 'UTF-16 bytes untouched');
    assert.ok(r.stdout.includes('UTF-16LE BOM'));
  });
});

test('e2e: --diff prints a unified diff', () => {
  withTree({ 'd.txt': 'alpha  \nbeta\n' }, (root) => {
    const r = runBin(['--diff', '--strip-trailing-whitespace', 'd.txt'], root);
    assert.equal(r.status, 0);
    assert.ok(r.stdout.includes('--- a/d.txt'));
    assert.ok(r.stdout.includes('+++ b/d.txt'));
    assert.ok(r.stdout.includes('@@'));
    assert.ok(r.stdout.includes('-alpha  '));
  });
});

test('e2e: --json emits parseable JSON with real byte counts', () => {
  withTree({ 'd.txt': 'alpha  \nbeta\n' }, (root) => {
    const r = runBin(['--json', '--strip-trailing-whitespace', 'd.txt'], root);
    assert.equal(r.status, 0);
    const data = JSON.parse(r.stdout);
    assert.equal(data.summary.wouldChange, 1);
    assert.equal(data.files[0].path, 'd.txt');
    assert.equal(data.files[0].status, 'would-change');
    assert.equal(data.files[0].bytesBefore, 13); // 'alpha  \nbeta\n'
    assert.equal(data.files[0].bytesAfter, 11); // 'alpha\nbeta\n'
    // No --write, so the file on disk is untouched; the number describes what a
    // write WOULD produce, and it matches the plan() result exactly.
    assert.equal(fs.readFileSync(path.join(root, 'd.txt'), 'utf8'), 'alpha  \nbeta\n');
    assert.equal(
      require('../src/normalize.js').plan(fs.readFileSync(path.join(root, 'd.txt')), {
        filePath: 'd.txt',
        stripTrailingWhitespace: true,
      }).after.length,
      data.files[0].bytesAfter,
      'the reported after-size matches the plan',
    );
    assert.ok(data.files[0].reasons.includes('trailing-whitespace-stripped'));
  });
});

test('e2e: --write marks files as written in JSON output', () => {
  withTree({ 'd.txt': 'alpha  \n' }, (root) => {
    const r = runBin(['--json', '--write', '--strip-trailing-whitespace', 'd.txt'], root);
    const data = JSON.parse(r.stdout);
    assert.equal(data.files[0].written, true);
    assert.equal(fs.readFileSync(path.join(root, 'd.txt'), 'utf8'), 'alpha\n');
  });
});

test('e2e: --version prints the real version', () => {
  withTree({}, (root) => {
    const r = runBin(['--version'], root);
    assert.equal(r.status, 0);
    assert.equal(r.stdout.trim(), VERSION);
  });
});

test('e2e: --help exits 0 and documents the safe default', () => {
  withTree({}, (root) => {
    const r = runBin(['--help'], root);
    assert.equal(r.status, 0);
    assert.ok(r.stdout.includes('--check'));
    assert.ok(r.stdout.includes('REPORTS'));
  });
});

test('e2e: an unknown flag exits 2', () => {
  withTree({}, (root) => {
    const r = runBin(['--nope'], root);
    assert.equal(r.status, 2);
    assert.ok(r.stderr.includes('unknown option'));
  });
});

test('e2e: a missing path exits 2', () => {
  withTree({}, (root) => {
    const r = runBin(['does-not-exist.txt'], root);
    assert.equal(r.status, 2);
    assert.ok(r.stdout.includes('no such file'));
  });
});

test('e2e: --quiet hides clean files but still shows problems', () => {
  withTree({ 'clean.txt': 'a\n', 'dirty.txt': 'b  \n' }, (root) => {
    const r = runBin(['--quiet', '--strip-trailing-whitespace', '.'], root);
    assert.ok(!r.stdout.includes('clean.txt'), 'clean file not listed');
    assert.ok(r.stdout.includes('dirty.txt'), 'dirty file still listed');
  });
});

test('e2e: --ext restricts the walk', () => {
  withTree({ 'a.js': 'x  \n', 'b.md': 'y  \n' }, (root) => {
    const r = runBin(['--check', '--ext', '.js', '--strip-trailing-whitespace', '.'], root);
    assert.equal(r.status, 1);
    assert.ok(r.stdout.includes('a.js'));
    assert.ok(!r.stdout.includes('b.md'));
  });
});

test('e2e: --exclude skips files', () => {
  withTree({ 'a.js': 'x  \n', 'skipme.js': 'y  \n' }, (root) => {
    const r = runBin(['--check', '--exclude', 'skipme.js', '--strip-trailing-whitespace', '.'], root);
    assert.equal(r.status, 1);
    assert.ok(r.stdout.includes('a.js'));
    assert.ok(!r.stdout.includes('skipme.js'));
  });
});

test('e2e: a markdown fence survives --write while prose is cleaned', () => {
  const md = ['intro  ', '```js', 'const a = 1;   ', '```', 'outro  ', ''].join('\n');
  withTree({ 'doc.md': md }, (root) => {
    const r = runBin(['--write', '--strip-trailing-whitespace', 'doc.md'], root);
    assert.equal(r.status, 0);
    const after = fs.readFileSync(path.join(root, 'doc.md'), 'utf8');
    assert.equal(after, ['intro', '```js', 'const a = 1;   ', '```', 'outro', ''].join('\n'));
  });
});

test('e2e: file mode is preserved across --write', () => {
  withTree({ 'script.sh': '#!/bin/sh\r\necho hi  \r\n' }, (root) => {
    const file = path.join(root, 'script.sh');
    fs.chmodSync(file, 0o755);
    const r = runBin(['--write', '--eol', 'lf', '--strip-trailing-whitespace', 'script.sh'], root);
    assert.equal(r.status, 0);
    assert.equal(fs.statSync(file).mode & 0o777, 0o755, 'executable bit survived');
    assert.equal(fs.readFileSync(file, 'utf8'), '#!/bin/sh\necho hi\n');
  });
});

test('e2e: no temp files are left behind after --write', () => {
  withTree({ 'a.txt': 'x  \n' }, (root) => {
    runBin(['--write', '--strip-trailing-whitespace', '.'], root);
    const leftovers = fs.readdirSync(root).filter((f) => f.includes('textclean') || f.endsWith('.tmp'));
    assert.deepEqual(leftovers, []);
  });
});

test('e2e: running --write twice is idempotent (second run is a no-op)', () => {
  withTree({ 'a.txt': '\uFEFFa  \r\nb\r\n' }, (root) => {
    const args = ['--write', '--eol', 'lf', '--strip-bom', '--strip-trailing-whitespace', 'a.txt'];
    assert.equal(runBin(args, root).status, 0);
    const once = fs.readFileSync(path.join(root, 'a.txt'));
    assert.equal(runBin(args, root).status, 0);
    const twice = fs.readFileSync(path.join(root, 'a.txt'));
    assert.ok(once.equals(twice), 'second pass changed nothing');
    assert.equal(once.toString('utf8'), 'a\nb\n');
  });
});

test('e2e: --check after --write exits 0', () => {
  withTree({ 'a.txt': 'x  \r\n' }, (root) => {
    runBin(['--write', '--eol', 'lf', '--strip-trailing-whitespace', 'a.txt'], root);
    const r = runBin(['--check', '--eol', 'lf', '--strip-trailing-whitespace', 'a.txt'], root);
    assert.equal(r.status, 0);
  });
});

test('e2e: the tool never leaves a file with mixed line endings', () => {
  withTree({ 'm.txt': 'a\r\nb\nc\rd\n' }, (root) => {
    runBin(['--write', '--eol', 'lf', 'm.txt'], root);
    const after = fs.readFileSync(path.join(root, 'm.txt'), 'utf8');
    assert.ok(!after.includes('\r'), 'no CR survived');
    assert.equal(after, 'a\nb\nc\nd\n');
  });
});

// ---------------------------------------------------------------------------
// Library-level file operations.
// ---------------------------------------------------------------------------

test('writeFileAtomic: replaces content and preserves mode', () => {
  withTree({ 'f.txt': 'old\n' }, (root) => {
    const file = path.join(root, 'f.txt');
    fs.chmodSync(file, 0o640);
    writeFileAtomic(file, 'new content\n');
    assert.equal(fs.readFileSync(file, 'utf8'), 'new content\n');
    assert.equal(fs.statSync(file).mode & 0o777, 0o640);
  });
});

test('inspectFile: classifies clean, would-change, binary', () => {
  withTree({ 'clean.txt': 'a\n', 'dirty.txt': 'b  \n', 'bin.dat': Buffer.from([0, 1]) }, (root) => {
    const opts = { stripTrailingWhitespace: true };
    assert.equal(inspectFile(path.join(root, 'clean.txt'), opts).status, 'clean');
    assert.equal(inspectFile(path.join(root, 'dirty.txt'), opts).status, 'would-change');
    assert.equal(inspectFile(path.join(root, 'bin.dat'), opts).status, 'binary');
  });
});

test('analyzeFile: reports size, mode and byte-level facts', () => {
  withTree({ 'a.txt': '\uFEFFa\r\nb' }, (root) => {
    const info = analyzeFile(path.join(root, 'a.txt'));
    assert.equal(info.size, 7); // 3 BOM + 'a\r\nb'
    assert.equal(info.bom.encoding, 'utf8');
    assert.equal(info.lineEndings.dominant, 'crlf');
    assert.equal(info.finalNewline, false);
    assert.ok(typeof info.mode === 'number');
  });
});

test('analyzeFile: a directory throws, handled by inspectFile as an error', () => {
  withTree({ 'sub/a.txt': 'x\n' }, (root) => {
    const result = inspectFile(path.join(root, 'sub'), {});
    assert.equal(result.status, 'error');
    assert.ok(result.error);
  });
});

// ---------------------------------------------------------------------------
// Documentation contract.
//
// The README used to say "With `--gitignore` on (the default)", implying a
// `--gitignore` flag that never existed -- the parser rejects it with
// "unknown option", so the sentence was a broken instruction that read like
// a real one. Nothing compared the README against the parser, so it survived.
// These tests make the docs and the parser one checked pair.
// ---------------------------------------------------------------------------

/** Flags the parser accepts, with a value where one is required. */
function acceptedFlagNames() {
  const flags = new Set();
  for (const name of USAGE.match(/(?:^|\s)(--[a-z][a-z0-9-]*)/g) || []) {
    flags.add(name.trim());
  }
  return flags;
}

test('every flag the README documents is a real flag', () => {
  const readme = fs.readFileSync(path.join(ROOT, 'README.md'), 'utf8');
  // Ignore the trailing "# 145 tests" line: `node --test` is the Node test
  // runner, not a textclean flag. Every other flag in the README has to parse.
  const documented = new Set(
    (readme.match(/(?:^|[^-\w])(--[a-z][a-z0-9-]*)/g) || []).map((s) => s.trim()),
  );
  const accepted = acceptedFlagNames();
  for (const flag of documented) {
    if (flag === '--test') continue; // `node --test` in the Running tests block
    assert.ok(
      accepted.has(flag) || parseArgs([flag]).paths !== undefined,
      `README documents ${flag}, which the parser does not accept`,
    );
  }
});

test('every flag in --help is a real flag', () => {
  for (const flag of acceptedFlagNames()) {
    // Valued flags need a value; the usage block lists the placeholder
    // (e.g. `--eol <lf|crlf|cr|keep>`), so try the bare flag first and, for
    // the ones that require a value, with a plausible one.
    const attempts = [[flag], [flag, 'lf'], [flag, '2'], [flag, 'a,b']];
    assert.ok(
      attempts.some((argv) => {
        try {
          parseArgs(argv);
          return true;
        } catch (err) {
          if (err.code !== 'TEXTCLEAN_BAD_USAGE') throw err;
          return false;
        }
      }),
      `--help documents ${flag}, which the parser does not accept`,
    );
  }
});

test('the .gitignore prose matches the actual default', () => {
  // DEFAULTS.gitignore is the truth; the README must not imply a flag that
  // does not exist, and must not claim the default is off.
  assert.equal(DEFAULTS.gitignore, true, 'gitignore handling is expected to default on');
  assert.throws(() => parseArgs(['--gitignore']), (err) => {
    assert.equal(err.code, 'TEXTCLEAN_BAD_USAGE');
    assert.match(err.message, /unknown option --gitignore/);
    return true;
  });
  assert.equal(parseArgs(['--no-gitignore']).options.gitignore, false);

  const readme = fs.readFileSync(path.join(ROOT, 'README.md'), 'utf8');
  const claim = readme.match(/`--gitignore` on the?/);
  assert.equal(claim, null, 'README still implies a --gitignore flag exists');
});
