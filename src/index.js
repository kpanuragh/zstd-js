'use strict';

// Zstandard compression in pure JavaScript.
//
// Entropy coding is still being built out; today every block is emitted as a
// Raw_Block or an RLE_Block, so output is valid zstd that any decoder reads
// but is not yet smaller than the input. The frame, block and bitstream
// layers underneath are complete.

var c = require('./constants');
var frame = require('./frame');

function toBytes(input) {
  if (typeof input === 'string') return Buffer.from(input, 'utf8');
  if (Buffer.isBuffer(input)) return input;
  if (ArrayBuffer.isView(input)) return Buffer.from(input.buffer, input.byteOffset, input.byteLength);
  if (input instanceof ArrayBuffer) return Buffer.from(input);
  throw new TypeError('input must be a string, Buffer, TypedArray, DataView or ArrayBuffer');
}

// True when every byte of the slice is identical, which an RLE_Block can
// represent in a single byte.
function isRun(src, start, end) {
  var first = src[start];
  for (var i = start + 1; i < end; i++) {
    if (src[i] !== first) return false;
  }
  return true;
}

function compress(input, options) {
  options = options || {};
  var src = toBytes(input);

  var parts = [frame.writeFrameHeader(src.length, { checksum: false })];

  if (src.length === 0) {
    parts.push(frame.writeBlockHeader(0, c.BLOCK_RAW, true));
    return Buffer.concat(parts);
  }

  var offset = 0;
  while (offset < src.length) {
    var size = Math.min(c.BLOCK_SIZE_MAX, src.length - offset);
    var last = offset + size >= src.length;

    if (size > 1 && isRun(src, offset, offset + size)) {
      // Section 3.1.1.2: an RLE_Block's content is one byte, and Block_Size
      // is the number of times it repeats.
      parts.push(frame.writeBlockHeader(size, c.BLOCK_RLE, last));
      parts.push(Buffer.from([src[offset]]));
    } else {
      parts.push(frame.writeBlockHeader(size, c.BLOCK_RAW, last));
      parts.push(src.subarray(offset, offset + size));
    }

    offset += size;
  }

  return Buffer.concat(parts);
}

exports.compress = compress;
exports.constants = c;
