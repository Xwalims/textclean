'use strict';

/**
 * Every option default lives in exactly ONE frozen object.
 *
 * Rule of thumb followed by this project: a default that exists in two places
 * is a default that will eventually disagree with itself.
 */

/** Frozen, exported, single source of truth for all defaults. */
const DEFAULTS = Object.freeze({
  // ---- transformations (src/normalize.js) --------------------------------
  /** 'lf' | 'crlf' | 'cr' | 'keep' */
  eol: 'keep',
  /** Force CRLF regardless of `eol` (shorthand for --eol crlf). */
  ensureCrlf: false,
  /** Remove a leading byte-order mark. */
  stripBom: false,
  /** Append a final newline when one is missing. */
  ensureFinalNewline: false,
  /** Remove the final newline. */
  noFinalNewline: false,
  /** Strip trailing spaces/tabs from each line. */
  stripTrailingWhitespace: false,
  /** Strip leading spaces/tabs from each line. */
  trimLeadingWhitespace: false,
  /** Expand tabs to N-column tab stops. 0 = off. */
  tabsToSpaces: 0,
  /** Cap consecutive blank lines at N. 0 = off. */
  collapseBlankLines: 0,
  /** Remove blank lines at end of file. */
  noTrailingBlankLines: false,
  /** true | false | null (null = auto: on for .md/.markdown only). */
  skipCodeFences: null,

  // ---- walking (src/walk.js) ---------------------------------------------
  /** Glob patterns excluded from the walk. `.git`/`node_modules` always skipped. */
  exclude: Object.freeze([]),
  /** Restrict to these extensions (lowercase, with leading dot). null = all. */
  ext: null,
  /** Honour .gitignore files found during the walk. */
  gitignore: true,
  /** Directory names never descended into, regardless of anything else. */
  alwaysSkipDirs: Object.freeze(['.git', 'node_modules']),
  /** Do not follow symbolic links (avoids cycles). */
  followSymlinks: false,

  // ---- behaviour (src/cli.js) --------------------------------------------
  /** Report only; exit 1 when a file would change. */
  check: false,
  /** Print a unified diff of the proposed changes. */
  diff: false,
  /** Write changes to disk atomically. */
  write: false,
  /** Machine-readable output. */
  json: false,
  /** Suppress the per-file report. */
  quiet: false,
});

/** Exit codes used by the CLI. */
const EXIT = Object.freeze({
  OK: 0,
  CHECK_FAILED: 1,
  ERROR: 2,
});

/** Extensions where fenced code blocks are recognised. */
const MARKDOWN_EXTENSIONS = Object.freeze(['.md', '.markdown']);

/**
 * Merge a user options object over DEFAULTS. Returns a plain (unfrozen) object
 * so callers may mutate their copy freely; unknown keys are dropped so a typo
 * in a library caller cannot silently do nothing.
 *
 * @param {object} [options]
 * @returns {object}
 */
function withDefaults(options = {}) {
  const out = {};
  for (const key of Object.keys(DEFAULTS)) {
    const value = options[key];
    if (value === undefined) {
      out[key] = DEFAULTS[key];
    } else if (Array.isArray(DEFAULTS[key])) {
      out[key] = Array.from(value);
    } else {
      out[key] = value;
    }
  }
  return out;
}

/** Validate/normalise a merged options object. Throws Error with code. */
function validateOptions(options) {
  if (!['lf', 'crlf', 'cr', 'keep'].includes(options.eol)) {
    throw invalidOption(`--eol must be one of lf|crlf|cr|keep (got ${JSON.stringify(options.eol)})`);
  }
  if (options.tabsToSpaces !== 0 && !(Number.isInteger(options.tabsToSpaces) && options.tabsToSpaces > 0)) {
    throw invalidOption(`--tabs-to-spaces needs a positive integer (got ${JSON.stringify(options.tabsToSpaces)})`);
  }
  if (options.collapseBlankLines !== 0 && !(Number.isInteger(options.collapseBlankLines) && options.collapseBlankLines >= 0)) {
    throw invalidOption(`--collapse-blank-lines needs a non-negative integer (got ${JSON.stringify(options.collapseBlankLines)})`);
  }
  if (options.skipCodeFences !== null && typeof options.skipCodeFences !== 'boolean') {
    throw invalidOption('--skip-code-fences takes no value; use --no-skip-code-fences to disable it');
  }
  return options;
}

function invalidOption(message) {
  const err = new Error(message);
  err.code = 'TEXTCLEAN_BAD_OPTION';
  return err;
}

/** Build a validated options object from a partial one. */
function normalizeOptions(options = {}) {
  return validateOptions(withDefaults(options));
}

module.exports = { DEFAULTS, EXIT, MARKDOWN_EXTENSIONS, withDefaults, normalizeOptions, validateOptions };
