'use strict';

const fs = require('node:fs');
const path = require('node:path');

const { DEFAULTS, EXIT, normalizeOptions } = require('./options.js');
const { detectLineEndings } = require('./detect.js');
const { walk, extensionOf } = require('./walk.js');
const { inspectFile, writeFileAtomic } = require('./fileops.js');
const { unifiedDiff } = require('./diff.js');

const VERSION = '0.1.0';

const USAGE = `textclean ${VERSION} — text hygiene normalizer (zero dependencies)

USAGE
  textclean [paths...] [options]

  With no --write/--in-place, textclean only REPORTS. It never modifies a file
  unless you explicitly ask it to.

OPTIONS
  Transformation
    --eol <lf|crlf|cr|keep>   Normalize line endings            (default keep)
    --ensure-crlf            Shorthand for --eol crlf
    --strip-bom              Remove a leading UTF-8 byte-order mark
    --ensure-final-newline   Add a trailing newline when missing
    --no-final-newline       Remove the trailing newline
    --strip-trailing-whitespace
    --trim-leading-whitespace
    --tabs-to-spaces <n>     Expand tabs to n-column tab stops
    --collapse-blank-lines <n>   Cap consecutive blank lines at n
    --no-trailing-blank-lines
    --skip-code-fences       Protect fenced code blocks in Markdown
    --no-skip-code-fences    ...or do not (auto-on for .md/.markdown)

  Selection
    --ext <a,b,c>            Only these extensions (.js,.md,...)
    --exclude <glob,...>     Skip matching paths ('*' vs '**')
    --no-gitignore           Do not honour .gitignore files
                             (.gitignore files are honoured by default)
    --follow-symlinks        Descend through symlinks

  Behaviour
    --check                  Exit 1 if any file would change (for CI)
    --diff                   Print a unified diff of the changes
    --write, --in-place      Apply changes to disk (atomic, mode preserved)
    --json                   Machine-readable output
    --quiet                  Only print problems
    -h, --help               This help
    -v, --version            Print the version

EXIT CODES
  0  clean (or changes written in --write mode)
  1  --check found at least one file that would change
  2  bad usage, or a file could not be processed

EXAMPLES
  textclean . --check --eol lf --strip-trailing-whitespace
  textclean README.md --diff --strip-bom --eol lf
  textclean src --write --eol lf --strip-bom --ensure-final-newline
`;

/** Options that take a value. */
const VALUE_FLAGS = new Set(['--eol', '--ext', '--exclude', '--tabs-to-spaces', '--collapse-blank-lines']);

/**
 * Parse argv into `{ paths, options }`.
 * Throws an Error with `.code = 'TEXTCLEAN_BAD_USAGE'` on bad input.
 *
 * @param {string[]} argv arguments after the node binary and script
 */
function parseArgs(argv) {
  const paths = [];
  const raw = {};
  let exclude = [];
  let ext = null;
  let noGitignore = false;
  let help = false;
  let version = false;
  let quiet = false;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];

    if (arg === '--') {
      paths.push(...argv.slice(i + 1));
      break;
    }
    if (!arg.startsWith('-')) {
      paths.push(arg);
      continue;
    }

    // Support `--flag=value`.
    let flag = arg;
    let inlineValue = null;
    const eq = arg.indexOf('=');
    if (eq !== -1) {
      flag = arg.slice(0, eq);
      inlineValue = arg.slice(eq + 1);
    }

    const takeValue = () => {
      if (inlineValue !== null) return inlineValue;
      i += 1;
      if (i >= argv.length) throw usageError(`${flag} needs a value`);
      return argv[i];
    };

    if (flag === '--help' || flag === '-h') { help = true; continue; }
    if (flag === '--version' || flag === '-v') { version = true; continue; }
    if (flag === '--quiet' || flag === '-q') { quiet = true; continue; }
    if (flag === '--check') { raw.check = true; continue; }
    if (flag === '--diff') { raw.diff = true; continue; }
    if (flag === '--json') { raw.json = true; continue; }
    if (flag === '--write' || flag === '--in-place') { raw.write = true; continue; }
    if (flag === '--strip-bom') { raw.stripBom = true; continue; }
    if (flag === '--ensure-final-newline') { raw.ensureFinalNewline = true; continue; }
    if (flag === '--no-final-newline') { raw.noFinalNewline = true; continue; }
    if (flag === '--strip-trailing-whitespace') { raw.stripTrailingWhitespace = true; continue; }
    if (flag === '--trim-leading-whitespace') { raw.trimLeadingWhitespace = true; continue; }
    if (flag === '--no-trailing-blank-lines') { raw.noTrailingBlankLines = true; continue; }
    if (flag === '--ensure-crlf') { raw.ensureCrlf = true; continue; }
    if (flag === '--skip-code-fences') { raw.skipCodeFences = true; continue; }
    if (flag === '--no-skip-code-fences') { raw.skipCodeFences = false; continue; }
    if (flag === '--follow-symlinks') { raw.followSymlinks = true; continue; }
    if (flag === '--no-gitignore') { noGitignore = true; continue; }

    if (flag === '--eol') { raw.eol = takeValue(); continue; }
    if (flag === '--tabs-to-spaces') { raw.tabsToSpaces = toInt(takeValue(), flag); continue; }
    if (flag === '--collapse-blank-lines') { raw.collapseBlankLines = toInt(takeValue(), flag); continue; }
    if (flag === '--exclude') { exclude = exclude.concat(splitList(takeValue())); continue; }
    if (flag === '--ext') {
      // Repeatable and additive, so `--ext .js --ext .md` works as expected.
      const added = splitList(takeValue()).map((e) => (e.startsWith('.') ? e : `.${e}`).toLowerCase());
      ext = (ext || []).concat(added);
      continue;
    }

    throw usageError(`unknown option ${flag}`);
  }

  const options = normalizeOptions({
    ...raw,
    quiet,
    exclude,
    ext,
    gitignore: !noGitignore,
  });

  // Last flag wins is friendlier than silently letting a no-* do nothing.
  if (options.ensureFinalNewline && options.noFinalNewline) {
    throw usageError('--ensure-final-newline and --no-final-newline contradict each other');
  }
  if (options.ensureCrlf && options.eol !== 'keep' && options.eol !== 'crlf') {
    throw usageError(`--ensure-crlf contradicts --eol ${options.eol}`);
  }

  return { paths, options, help, version };
}

function usageError(message) {
  const err = new Error(message);
  err.code = 'TEXTCLEAN_BAD_USAGE';
  return err;
}

function toInt(value, flag) {
  const n = Number(value);
  if (!Number.isInteger(n)) throw usageError(`${flag} needs an integer (got ${JSON.stringify(value)})`);
  return n;
}

function splitList(value) {
  return value
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s !== '');
}

/** Build the file list from the given paths (files are used directly). */
function collectFiles(paths, options) {
  const targets = paths.length ? paths : ['.'];
  const files = [];
  const missing = [];

  for (const target of targets) {
    let stat;
    try {
      stat = fs.statSync(target);
    } catch {
      missing.push(target);
      continue;
    }
    if (stat.isDirectory()) {
      files.push(...walk(target, options));
    } else {
      const ext = extensionOf(target);
      if (options.ext && !options.ext.includes(ext)) continue;
      files.push(path.resolve(target));
    }
  }

  files.sort();
  return { files: Array.from(new Set(files)), missing };
}

const REASON_LABELS = {
  'bom-removed': 'BOM removed',
  'final-newline-added': 'final newline added',
  'final-newline-removed': 'final newline removed',
  'trailing-whitespace-stripped': 'trailing whitespace stripped',
  'leading-whitespace-trimmed': 'leading whitespace trimmed',
  'tabs-expanded': 'tabs expanded',
  'blank-lines-collapsed': 'blank lines collapsed',
  'trailing-blank-lines-removed': 'trailing blank lines removed',
};

function labelFor(reason) {
  return REASON_LABELS[reason] || reason;
}

/**
 * Human label for a line-ending change, or null when the terminators did not
 * actually change style.
 *
 * The comparison ignores a single trailing newline on each side. Otherwise
 * --ensure-final-newline alone would report a meaningless "lf → lf", since
 * adding the final terminator changes the terminator COUNT but not the style.
 */
function eolLabel(result) {
  const stripTail = (s) => s.replace(/[\r\n]+$/, '');
  const before = detectLineEndings(stripTail(result.before));
  const after = detectLineEndings(stripTail(result.after));
  if (before.dominant === after.dominant && before.total === after.total) return null;
  if (before.dominant === after.dominant) return null; // same style, only counts moved
  return `${before.dominant} → ${after.dominant}`;
}

function humanSize(bytes) {
  if (Math.abs(bytes) < 1024) return `${bytes} B`;
  const kb = bytes / 1024;
  if (Math.abs(kb) < 1024) return `${kb.toFixed(1)} KiB`;
  return `${(kb / 1024).toFixed(1)} MiB`;
}

/**
 * Present a path the way the user typed it: relative to the working directory
 * when it is below it, otherwise absolute. Walking produces absolute paths;
 * printing /home/user/repo/src/cli.js when the user ran `textclean .` is noise.
 */
function displayPath(absolute, cwd) {
  const rel = path.relative(cwd, absolute);
  if (rel === '') return '.';
  if (rel.startsWith('..')) return absolute;
  return rel;
}

/**
 * CLI entry point.
 *
 * @param {string[]} argv
 * @param {{stdout?: NodeJS.WritableStream, stderr?: NodeJS.WritableStream}} [io]
 * @returns {number} process exit code
 */
function main(argv, io = {}) {
  const stdout = io.stdout || process.stdout;
  const stderr = io.stderr || process.stderr;
  const cwd = io.cwd || process.cwd();

  let parsed;
  try {
    parsed = parseArgs(argv);
  } catch (err) {
    stderr.write(`textclean: ${err.message}\n\nRun \`textclean --help\` for usage.\n`);
    return EXIT.ERROR;
  }

  const { paths, options, help, version } = parsed;

  if (help) {
    stdout.write(USAGE);
    return EXIT.OK;
  }
  if (version) {
    stdout.write(`${VERSION}\n`);
    return EXIT.OK;
  }

  const { files, missing } = collectFiles(paths, options);
  const results = [];
  let hadError = false;

  for (const file of files) {
    const result = inspectFile(file, options);
    if (result.status === 'error') hadError = true;
    results.push(result);
  }

  const changed = results.filter((r) => r.status === 'would-change');
  const binary = results.filter((r) => r.status === 'binary');
  const unsupported = results.filter((r) => r.status === 'unsupported');

  // --write actually writes. Atomic rename, mode preserved.
  if (options.write) {
    for (const result of changed) {
      try {
        writeFileAtomic(result.path, Buffer.from(result.plan.after, 'utf8'));
        result.written = true;
      } catch (err) {
        result.status = 'error';
        result.error = err.message;
        hadError = true;
      }
    }
  }

  if (options.json) {
    const payload = buildJson(options, results, missing, changed, cwd);
    stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
    return finish(options, changed.length > 0, hadError || missing.length > 0);
  }

  renderHuman(stdout, options, results, missing, changed, cwd);

  return finish(options, changed.length > 0, hadError || missing.length > 0);
}

function finish(options, anyChanged, hadError) {
  if (hadError) return EXIT.ERROR;
  if (options.check && anyChanged) return EXIT.CHECK_FAILED;
  return EXIT.OK;
}

function buildJson(options, results, missing, changed, cwd = process.cwd()) {
  return {
    version: VERSION,
    write: options.write,
    check: options.check,
    summary: {
      files: results.length,
      wouldChange: changed.length,
      clean: results.filter((r) => r.status === 'clean').length,
      binary: results.filter((r) => r.status === 'binary').length,
      unsupported: results.filter((r) => r.status === 'unsupported').length,
      errors: results.filter((r) => r.status === 'error').length,
    },
    missing,
    files: results.map((r) => ({
      path: displayPath(r.path, cwd),
      absolutePath: r.path,
      status: r.status,
      bom: r.bom,
      eol: r.eol,
      bytesBefore: r.before,
      bytesAfter: r.after,
      reasons: r.reasons,
      written: Boolean(r.written),
      error: r.error,
    })),
  };
}

function renderHuman(stdout, options, results, missing, changed, cwd) {
  const quiet = options.quiet;
  const binary = results.filter((r) => r.status === 'binary');
  const out = [];

  for (const result of results) {
    const rel = displayPath(result.path, cwd);

    if (result.status === 'error') {
      out.push(`ERROR  ${rel}: ${result.error}`);
      continue;
    }
    if (result.status === 'binary') {
      if (!quiet) out.push(`SKIP   ${rel} (binary: NUL byte detected, never modified)`);
      continue;
    }
    if (result.status === 'unsupported') {
      out.push(`SKIP   ${rel} (${result.error})`);
      continue;
    }
    if (result.status === 'clean') {
      if (!quiet) out.push(`ok     ${rel}`);
      continue;
    }

    // would-change / written
    const labels = result.reasons.map(labelFor);
    const eol = eolLabel(result.plan);
    if (eol) labels.unshift(eol);
    const delta = result.after - result.before;
    const size = `${humanSize(result.before)} → ${humanSize(result.after)} (${delta >= 0 ? '+' : ''}${delta} B)`;
    const verb = result.written ? 'fixed' : 'would fix';
    out.push(`${verb.padEnd(9)} ${rel}`);
    out.push(`${''.padEnd(9)} ${labels.join(', ')}`);
    out.push(`${''.padEnd(9)} ${size}`);
    if (options.diff && !result.written) {
      const diff = unifiedDiff(result.plan.before, result.plan.after, rel);
      if (diff) out.push(diff.replace(/\n$/, ''));
    }
  }

  for (const m of missing) out.push(`ERROR  ${m}: no such file or directory`);

  const counts = [];
  if (changed.length) {
    counts.push(
      options.write
        ? `${changed.length} file${changed.length === 1 ? '' : 's'} fixed`
        : `${changed.length} file${changed.length === 1 ? '' : 's'} would change`
    );
  }
  if (!changed.length && !quiet) counts.push('all clean');
  if (binary.length && !quiet) counts.push(`${binary.length} skipped (binary)`);
  if (counts.length) out.push(counts.join(', '));

  if (options.check && changed.length) {
    out.push('check failed: run with --write to apply');
  }

  if (out.length) stdout.write(`${out.join('\n')}\n`);
}

module.exports = { main, parseArgs, USAGE, VERSION, collectFiles, DEFAULTS, EXIT };
