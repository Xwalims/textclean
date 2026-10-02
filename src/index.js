'use strict';

/**
 * textclean — text hygiene normalizer.
 *
 * Library API:
 *   const { analyzeFile, plan, apply } = require('textclean');
 *
 *   analyzeFile(path)   -> byte-level facts about a file on disk
 *   plan(content, opts) -> { changed, before, after, reasons, analysis }
 *   apply(content, opts)-> the transformed content (Buffer in, Buffer out)
 *
 * `plan` never writes. `apply` never writes either — it is a pure function.
 * Writing is the CLI's job (src/fileops.js, atomic rename + mode preserved).
 */

const { analyzeBuffer, detectBom, detectLineEndings, isBinary } = require('./detect.js');
const { plan, apply } = require('./normalize.js');
const { analyzeFile, writeFileAtomic, inspectFile } = require('./fileops.js');
const { unifiedDiff } = require('./diff.js');
const { walk } = require('./walk.js');
const { DEFAULTS, EXIT, normalizeOptions, MARKDOWN_EXTENSIONS } = require('./options.js');
const cli = require('./cli.js');

module.exports = {
  // primary API
  analyzeFile,
  plan,
  apply,
  // supporting pieces, exported because they are useful and cheap to test
  analyzeBuffer,
  detectBom,
  detectLineEndings,
  isBinary,
  writeFileAtomic,
  inspectFile,
  unifiedDiff,
  walk,
  // config
  DEFAULTS,
  EXIT,
  MARKDOWN_EXTENSIONS,
  normalizeOptions,
  version: cli.VERSION,
  cliMain: cli.main,
};
