'use strict';

const fs = require('node:fs');
const path = require('node:path');

const { analyzeBuffer } = require('./detect.js');
const { plan } = require('./normalize.js');

/**
 * File-level entry points used by the CLI and exposed as the library API.
 */

/**
 * Read a file and describe its byte-level properties.
 *
 * @param {string} filePath
 * @returns {{path: string, size: number, mode: number, bom: object,
 *            lineEndings: object, binary: boolean, finalNewline: boolean,
 *            supported: boolean, reason: string|null}}
 */
function analyzeFile(filePath) {
  const buffer = fs.readFileSync(filePath);
  const stat = fs.statSync(filePath);
  const info = analyzeBuffer(buffer);
  return { path: filePath, size: stat.size, mode: stat.mode, ...info };
}

/**
 * Write `content` to `filePath` atomically: a temp file in the same directory is
 * written, fsync'd, then rename(2)'d over the target. rename(2) is atomic
 * within a filesystem, so a reader never observes a half-written file, and a
 * crash mid-write leaves the original intact.
 *
 * The file MODE is preserved explicitly — a plain write through a fresh temp
 * file would otherwise reset an executable bit back to the process umask.
 *
 * @param {string} filePath
 * @param {Buffer|string} content
 */
function writeFileAtomic(filePath, content) {
  const dir = path.dirname(path.resolve(filePath));
  const stat = fs.statSync(filePath);
  const tmp = path.join(dir, `.${path.basename(filePath)}.textclean-${process.pid}-${counter()}.tmp`);

  const data = Buffer.isBuffer(content) ? content : Buffer.from(content, 'utf8');
  let fd;
  try {
    fd = fs.openSync(tmp, 'wx', stat.mode & 0o777);
    fs.writeFileSync(fd, data);
    fs.fsyncSync(fd);
  } catch (err) {
    if (fd !== undefined) {
      try { fs.closeSync(fd); } catch { /* already failing */ }
    }
    try { fs.unlinkSync(tmp); } catch { /* nothing to clean */ }
    throw err;
  }
  fs.closeSync(fd);
  // chmod in case the umask clipped bits off the temp file's own creation mode.
  fs.chmodSync(tmp, stat.mode & 0o777);
  fs.renameSync(tmp, filePath);
}

let _counter = 0;
function counter() {
  _counter += 1;
  return _counter;
}

/**
 * Full per-file pass: read, plan, and report what WOULD change.
 *
 * @param {string} filePath
 * @param {object} options
 * @returns {{path: string, status: 'clean'|'would-change'|'binary'|'unsupported'|'error',
 *            before: number, after: number, reasons: string[], error: string|null,
 *            bom: string|null, eol: string, plan: object}}
 */
function inspectFile(filePath, options) {
  const opts = { ...options, filePath };
  try {
    const buffer = fs.readFileSync(filePath);
    const sizeBefore = buffer.length;
    const result = plan(buffer, opts);
    const afterBuffer = Buffer.from(result.after, 'utf8');

    const bomName = result.analysis.bom.encoding;
    // 'unsupported' outranks 'binary', matching the guard order in plan(): a
    // UTF-16 file has a real, actionable problem that "binary" would hide.
    const status = !result.supported
      ? 'unsupported'
      : result.binary
        ? 'binary'
        : result.changed
          ? 'would-change'
          : 'clean';

    return {
      path: filePath,
      status,
      before: sizeBefore,
      after: afterBuffer.length,
      reasons: result.reasons,
      error: result.reason,
      bom: bomName ? result.analysis.bom.name : null,
      eol: result.analysis.lineEndings.dominant,
      plan: result,
    };
  } catch (err) {
    return {
      path: filePath,
      status: 'error',
      before: 0,
      after: 0,
      reasons: [],
      error: err.message,
      bom: null,
      eol: 'unknown',
      plan: null,
    };
  }
}

module.exports = { analyzeFile, writeFileAtomic, inspectFile };
