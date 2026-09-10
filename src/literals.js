'use strict';

var bin = require('./bytes');

// Literals_Section encoding (RFC 8878 Section 3.1.1.3.1).

var c = require('./constants');

/**
 * Raw_Literals_Block: the literals are stored uncompressed, preceded by a
 * header carrying only Regenerated_Size.
 */
function writeRawLiterals(literals) {
  var size = literals.length;
  var header;

  if (size <= 31) {
    // Size_Format uses one bit; Regenerated_Size occupies bits 3-7.
    header = bin.from([c.LITERALS_RAW | (0 << 2) | (size << 3)]);
  } else if (size <= 4095) {
    header = bin.from([
      c.LITERALS_RAW | (1 << 2) | ((size & 0x0F) << 4),
      (size >> 4) & 0xFF
    ]);
  } else if (size <= 1048575) {
    header = bin.from([
      c.LITERALS_RAW | (3 << 2) | ((size & 0x0F) << 4),
      (size >> 4) & 0xFF,
      (size >> 12) & 0xFF
    ]);
  } else {
    throw new Error('literals section too large: ' + size);
  }

  return bin.concat([header, literals]);
}

/** RLE_Literals_Block: one byte repeated Regenerated_Size times. */
function writeRleLiterals(byte, size) {
  var header;
  if (size <= 31) {
    header = bin.from([c.LITERALS_RLE | (0 << 2) | (size << 3)]);
  } else if (size <= 4095) {
    header = bin.from([
      c.LITERALS_RLE | (1 << 2) | ((size & 0x0F) << 4),
      (size >> 4) & 0xFF
    ]);
  } else {
    header = bin.from([
      c.LITERALS_RLE | (3 << 2) | ((size & 0x0F) << 4),
      (size >> 4) & 0xFF,
      (size >> 12) & 0xFF
    ]);
  }
  return bin.concat([header, bin.from([byte])]);
}


/**
 * Compressed_Literals_Block header plus content (Section 3.1.1.3.1.1).
 *
 * Compressed_Size covers everything after the header: the tree description,
 * the jump table when there are four streams, and the streams themselves.
 *
 * Fields are packed low bits first: Literals_Block_Type, Size_Format,
 * Regenerated_Size, then Compressed_Size. The wider formats exceed 32 bits,
 * so this uses arithmetic throughout rather than bitwise operators.
 */
function writeCompressedLiterals(content, regeneratedSize, streamCount) {
  var compressedSize = content.length;
  var sizeFormat, headerBytes, sizeBits;

  if (streamCount === 1) {
    if (regeneratedSize > 1023 || compressedSize > 1023) return null;
    sizeFormat = 0; headerBytes = 3; sizeBits = 10;
  } else if (regeneratedSize <= 1023 && compressedSize <= 1023) {
    sizeFormat = 1; headerBytes = 3; sizeBits = 10;
  } else if (regeneratedSize <= 16383 && compressedSize <= 16383) {
    sizeFormat = 2; headerBytes = 4; sizeBits = 14;
  } else if (regeneratedSize <= 262143 && compressedSize <= 262143) {
    sizeFormat = 3; headerBytes = 5; sizeBits = 18;
  } else {
    return null;
  }

  var value = c.LITERALS_COMPRESSED +
    sizeFormat * 4 +
    regeneratedSize * 16 +
    compressedSize * 16 * Math.pow(2, sizeBits);

  return bin.concat([writeLE(value, headerBytes), content]);
}

// Little-endian across an arbitrary byte count, using arithmetic so values
// wider than 32 bits stay exact.
function writeLE(value, byteCount) {
  var out = bin.alloc(byteCount);
  for (var i = 0; i < byteCount; i++) {
    out[i] = value % 256;
    value = Math.floor(value / 256);
  }
  return out;
}

exports.writeCompressedLiterals = writeCompressedLiterals;

exports.writeRawLiterals = writeRawLiterals;
exports.writeRleLiterals = writeRleLiterals;
