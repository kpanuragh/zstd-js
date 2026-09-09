'use strict';

// Frame and block framing (RFC 8878 Section 3.1.1).

var c = require('./constants');

// Section 3.1.1.1.1: Frame_Header_Descriptor and the fields it selects.
//
// A frame may either declare Single_Segment_flag, in which case the decoder's
// window must span the whole content and no Window_Descriptor is written, or
// carry an explicit Window_Descriptor. We use a single segment when the
// content is small enough that requiring a window that size is harmless, and
// an explicit window otherwise.
var SINGLE_SEGMENT_LIMIT = 256 * 1024;

function windowLogFor(size) {
  var log = 10;
  while (log < 27 && (1 << log) < size) log++;
  return log;
}

function writeFrameHeader(contentSize, options) {
  options = options || {};
  var checksum = options.checksum ? 1 : 0;
  var known = contentSize !== null && contentSize !== undefined;

  // A dictionary sits behind the frame content, so the window has to span
  // both and a single segment will not do.
  var minimumWindow = options.minimumWindow || 0;

  var singleSegment = known && contentSize <= SINGLE_SEGMENT_LIMIT &&
    minimumWindow <= contentSize;

  // Section 3.1.1.1.1: Frame_Content_Size_flag selects the field width. A
  // flag of 0 means one byte when Single_Segment_flag is set, and no field
  // otherwise.
  // The 2-byte field stores contentSize - 256, so it cannot express anything
  // smaller than 256. A single segment can use the 1-byte field instead;
  // without one, small sizes fall through to the 4-byte field.
  var fcsFlag;
  if (!known) fcsFlag = 0;
  else if (singleSegment && contentSize < 256) fcsFlag = 0;
  else if (contentSize >= 256 && contentSize < 65536 + 256) fcsFlag = 1;
  else if (contentSize < 0x100000000) fcsFlag = 2;
  else fcsFlag = 3;

  var bytes = [];
  var header = Buffer.alloc(4);
  header.writeUInt32LE(c.MAGIC, 0);
  bytes.push(header);

  var descriptor = (fcsFlag << 6) | (singleSegment ? 0x20 : 0) | (checksum << 2);
  var rest = Buffer.alloc(9);
  var p = 0;
  rest[p++] = descriptor;

  if (!singleSegment) {
    // Section 3.1.1.1.2: Window_Size = base + (base / 8) * mantissa.
    var span = Math.max(known ? contentSize : 0, minimumWindow);
    var log = span > 0 ? windowLogFor(span) : 23;
    rest[p++] = ((log - 10) << 3);
  }

  if (known) {
    if (fcsFlag === 0 && singleSegment) rest.writeUInt8(contentSize, p), p += 1;
    else if (fcsFlag === 1) rest.writeUInt16LE(contentSize - 256, p), p += 2;
    else if (fcsFlag === 2) rest.writeUInt32LE(contentSize, p), p += 4;
    else if (fcsFlag === 3) rest.writeBigUInt64LE(BigInt(contentSize), p), p += 8;
  }

  bytes.push(rest.subarray(0, p));
  return Buffer.concat(bytes);
}

// Section 3.1.1.2: Block_Header is three bytes, little-endian:
// bit 0 Last_Block, bits 2-1 Block_Type, bits 23-3 Block_Size.
function writeBlockHeader(size, type, last) {
  var header = Buffer.alloc(3);
  header.writeUIntLE((size << 3) | (type << 1) | (last ? 1 : 0), 0, 3);
  return header;
}

exports.writeFrameHeader = writeFrameHeader;
exports.writeBlockHeader = writeBlockHeader;
exports.windowLogFor = windowLogFor;
exports.SINGLE_SEGMENT_LIMIT = SINGLE_SEGMENT_LIMIT;
