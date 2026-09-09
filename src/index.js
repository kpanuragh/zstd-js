'use strict';

// Zstandard compression in pure JavaScript.

var c = require('./constants');
var frame = require('./frame');
var block = require('./block');
var xxhash = require('./xxhash64');
var matchFinder = require('./match');
var stream = require('./stream');
var decode = require('./decode');

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
 * @param {{searchDepth?: number, windowSize?: number, checksum?: boolean}} [options]
 * @returns {Buffer}
 */
function compress(input, options) {
  options = options || {};
  var src = toBytes(input);
  var checksum = options.checksum === true;

  // A raw-content dictionary is simply data that precedes the frame: matches
  // may reach into it, and the decoder must be given the same bytes.
  var dictionary = options.dictionary ? toBytes(options.dictionary) : null;

  var parts = [frame.writeFrameHeader(src.length, {
    checksum: checksum,
    minimumWindow: dictionary ? dictionary.length + src.length : 0
  })];

  if (src.length === 0) {
    parts.push(frame.writeBlockHeader(0, c.BLOCK_RAW, true));
    if (checksum) parts.push(contentChecksum(src));
    return Buffer.concat(parts);
  }

  // Repeat-offset history persists across Compressed_Blocks within a frame.
  var reps = c.REPEAT_OFFSETS.slice();

  // One index over the whole input, so a block can match into earlier ones.
  // With a dictionary the index also covers the dictionary bytes, which sit
  // immediately before the content.
  var indexed = dictionary ? Buffer.concat([dictionary, src]) : src;
  var base = dictionary ? dictionary.length : 0;

  var finderOptions = options;
  if (dictionary) {
    finderOptions = Object.assign({}, options, {
      windowSize: Math.max(options.windowSize || 0, indexed.length)
    });
  }
  var finder = new matchFinder.MatchFinder(indexed, finderOptions);
  finder.prime(base);

  var offset = 0;
  while (offset < src.length) {
    var size = Math.min(c.BLOCK_SIZE_MAX, src.length - offset);
    var last = offset + size >= src.length;
    var encoded = block.encodeBlock(src.subarray(offset, offset + size), reps, options,
      finder, base + offset, base + offset + size);
    reps = encoded.reps;

    // Block_Size counts the stored content. For RLE that is the repeat count,
    // which is the regenerated size rather than the one stored byte.
    var declared = encoded.type === c.BLOCK_RLE ? encoded.regeneratedSize : encoded.content.length;

    parts.push(frame.writeBlockHeader(declared, encoded.type, last));
    parts.push(encoded.content);
    offset += size;
  }

  // Section 3.1.1.4: the frame ends with the low 32 bits of the content's
  // XXH64, when the descriptor said one is present.
  if (checksum) parts.push(contentChecksum(src));

  return Buffer.concat(parts);
}

function contentChecksum(src) {
  var out = Buffer.alloc(4);
  out.writeUInt32LE(xxhash.checksum32(src), 0);
  return out;
}

/**
 * Decompress a Zstandard frame.
 *
 * Handles frames from any Zstandard encoder, and verifies the content
 * checksum when the frame carries one.
 *
 * @param {string|Buffer|Uint8Array|DataView|ArrayBuffer} input
 * @param {{dictionary?: string|Buffer|Uint8Array|DataView|ArrayBuffer}} [options]
 * @returns {Buffer}
 */
function decompress(input, options) {
  options = options || {};
  return decode.decodeFrame(toBytes(input), {
    dictionary: options.dictionary ? toBytes(options.dictionary) : undefined
  });
}

exports.compress = compress;
exports.decompress = decompress;
exports.Compress = stream.Compress;
exports.Decompress = stream.Decompress;
exports.constants = c;
