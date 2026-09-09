'use strict';

// Zstandard compression in pure JavaScript.

var fzstd = require('fzstd');

var c = require('./constants');
var frame = require('./frame');
var block = require('./block');

function toBytes(input) {
  if (typeof input === 'string') return Buffer.from(input, 'utf8');
  if (Buffer.isBuffer(input)) return input;
  if (ArrayBuffer.isView(input)) return Buffer.from(input.buffer, input.byteOffset, input.byteLength);
  if (input instanceof ArrayBuffer) return Buffer.from(input);
  throw new TypeError('input must be a string, Buffer, TypedArray, DataView or ArrayBuffer');
}

/**
 * Compress input into a Zstandard frame.
 *
 * @param {string|Buffer|Uint8Array|DataView|ArrayBuffer} input
 * @param {{searchDepth?: number, windowSize?: number}} [options]
 * @returns {Buffer}
 */
function compress(input, options) {
  options = options || {};
  var src = toBytes(input);

  var parts = [frame.writeFrameHeader(src.length, { checksum: false })];

  if (src.length === 0) {
    parts.push(frame.writeBlockHeader(0, c.BLOCK_RAW, true));
    return Buffer.concat(parts);
  }

  // Repeat-offset history persists across Compressed_Blocks within a frame.
  var reps = c.REPEAT_OFFSETS.slice();

  var offset = 0;
  while (offset < src.length) {
    var size = Math.min(c.BLOCK_SIZE_MAX, src.length - offset);
    var last = offset + size >= src.length;
    var encoded = block.encodeBlock(src.subarray(offset, offset + size), reps, options);
    reps = encoded.reps;

    // Block_Size counts the stored content. For RLE that is the repeat count,
    // which is the regenerated size rather than the one stored byte.
    var declared = encoded.type === c.BLOCK_RLE ? encoded.regeneratedSize : encoded.content.length;

    parts.push(frame.writeBlockHeader(declared, encoded.type, last));
    parts.push(encoded.content);
    offset += size;
  }

  return Buffer.concat(parts);
}

/**
 * Decompress a Zstandard frame.
 *
 * Decoding is delegated to fzstd, which is a well-tested pure-JavaScript
 * Zstandard decoder. This package exists for the encoder, which had no pure-JS
 * implementation; there was no reason to write a second decoder.
 *
 * @param {string|Buffer|Uint8Array|DataView|ArrayBuffer} input
 * @returns {Buffer}
 */
function decompress(input) {
  var src = toBytes(input);
  var out = fzstd.decompress(new Uint8Array(src.buffer, src.byteOffset, src.byteLength));
  return Buffer.from(out.buffer, out.byteOffset, out.byteLength);
}

exports.compress = compress;
exports.decompress = decompress;
exports.constants = c;
