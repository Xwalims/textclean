'use strict';

/**
 * Byte-level detection of encoding hints and line-ending style.
 *
 * EVERY function in this module operates on the raw Buffer. Decoding to a
 * string first is exactly how BOM and CRLF bugs get introduced, so detection
 * and transformation both stay on the bytes.
 *
 * Note: UTF-32 BOMs are NOT detected (the UTF-32LE BOM starts with FF FE and is
 * therefore reported as "UTF-16LE"). textclean only rewrites UTF-8 text.
 */

const BOM_UTF8 = Buffer.from([0xef, 0xbb, 0xbf]);
const BOM_UTF16LE = Buffer.from([0xff, 0xfe]);
const BOM_UTF16BE = Buffer.from([0xfe, 0xff]);

const BOM_NAMES = {
  utf8: 'UTF-8 BOM',
  utf16le: 'UTF-16LE BOM',
  utf16be: 'UTF-16BE BOM',
};

/** Number of leading bytes inspected by the binary heuristic. */
const BINARY_SAMPLE_BYTES = 8000;

/**
 * Detect a byte-order mark.
 *
 * @param {Buffer|string} input
 * @returns {{encoding: string|null, length: number, name: string|null}}
 *   `encoding` is 'utf8' | 'utf16le' | 'utf16be' | null.
 */
function detectBom(input) {
  if (typeof input === 'string') {
    // A decoded UTF-8 BOM becomes U+FEFF, which is 1 char (3 bytes on the wire).
    if (input.charCodeAt(0) === 0xfeff) {
      return { encoding: 'utf8', length: 1, name: BOM_NAMES.utf8 };
    }
    return { encoding: null, length: 0, name: null };
  }

  const buf = input;
  if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) {
    return { encoding: 'utf8', length: 3, name: BOM_NAMES.utf8 };
  }
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) {
    return { encoding: 'utf16le', length: 2, name: BOM_NAMES.utf16le };
  }
  if (buf.length >= 2 && buf[0] === 0xfe && buf[1] === 0xff) {
    return { encoding: 'utf16be', length: 2, name: BOM_NAMES.utf16be };
  }
  return { encoding: null, length: 0, name: null };
}

/**
 * Count line terminators byte-wise, distinguishing CRLF from lone CR.
 *
 * @param {Buffer|string} input
 * @param {number} [start] byte offset to begin at (use the BOM length so the
 *   BOM bytes are never counted as content).
 * @returns {{crlf: number, lf: number, cr: number, total: number,
 *            dominant: 'crlf'|'lf'|'cr'|'mixed'|'none'}}
 */
function detectLineEndings(input, start = 0) {
  const buf = Buffer.isBuffer(input) ? input : Buffer.from(input, 'utf8');
  const from = Math.max(0, start | 0);
  let crlf = 0;
  let lf = 0;
  let cr = 0;

  for (let i = from; i < buf.length; i += 1) {
    const byte = buf[i];
    if (byte === 0x0d) {
      if (buf[i + 1] === 0x0a) {
        crlf += 1;
        i += 1;
      } else {
        cr += 1;
      }
    } else if (byte === 0x0a) {
      lf += 1;
    }
  }

  const total = crlf + lf + cr;
  const kinds = (crlf > 0 ? 1 : 0) + (lf > 0 ? 1 : 0) + (cr > 0 ? 1 : 0);

  let dominant;
  if (total === 0) dominant = 'none';
  else if (kinds > 1) dominant = 'mixed';
  else if (crlf > 0) dominant = 'crlf';
  else if (cr > 0) dominant = 'cr';
  else dominant = 'lf';

  return { crlf, lf, cr, total, dominant };
}

/** True when the final byte is a line terminator (LF or CR). */
function hasFinalNewline(input) {
  const buf = Buffer.isBuffer(input) ? input : Buffer.from(input, 'utf8');
  if (buf.length === 0) return false;
  const last = buf[buf.length - 1];
  return last === 0x0a || last === 0x0d;
}

/**
 * Binary heuristic: a NUL byte in the leading sample means "not text".
 * textclean never rewrites such a file.
 */
function isBinary(input, sampleBytes = BINARY_SAMPLE_BYTES) {
  const buf = Buffer.isBuffer(input) ? input : Buffer.from(input, 'utf8');
  const end = Math.min(buf.length, sampleBytes);
  for (let i = 0; i < end; i += 1) {
    if (buf[i] === 0x00) return true;
  }
  return false;
}

/** Byte offset of the first NUL, or -1. Handy for reporting. */
function firstNulOffset(input, sampleBytes = BINARY_SAMPLE_BYTES) {
  const buf = Buffer.isBuffer(input) ? input : Buffer.from(input, 'utf8');
  const end = Math.min(buf.length, sampleBytes);
  for (let i = 0; i < end; i += 1) {
    if (buf[i] === 0x00) return i;
  }
  return -1;
}

/**
 * Full byte-level analysis of a file.
 *
 * @param {Buffer} buffer
 * @returns {{bom: object, lineEndings: object, binary: boolean,
 *            finalNewline: boolean, size: number, supported: boolean,
 *            reason: string|null}}
 */
function analyzeBuffer(buffer) {
  const bom = detectBom(buffer);
  const lineEndings = detectLineEndings(buffer, bom.length);
  const binary = isBinary(buffer);
  const finalNewline = hasFinalNewline(buffer);

  // Decision, documented in the README: textclean handles UTF-8 only. UTF-16
  // input is *rejected with a clear message*, never silently re-encoded.
  const supported = bom.encoding === null || bom.encoding === 'utf8';
  const reason = supported
    ? null
    : `file starts with a ${bom.name}; textclean rewrites UTF-8 text only ` +
      '(re-save the file as UTF-8, e.g. `iconv -f utf-16 -t utf-8`)';

  return {
    bom,
    lineEndings,
    binary,
    finalNewline,
    size: buffer.length,
    supported,
    reason,
  };
}

module.exports = {
  BOM_UTF8,
  BOM_UTF16LE,
  BOM_UTF16BE,
  BINARY_SAMPLE_BYTES,
  detectBom,
  detectLineEndings,
  hasFinalNewline,
  isBinary,
  firstNulOffset,
  analyzeBuffer,
};
