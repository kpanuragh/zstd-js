'use strict';

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
    header = Buffer.from([c.LITERALS_RAW | (0 << 2) | (size << 3)]);
  } else if (size <= 4095) {
    header = Buffer.from([
      c.LITERALS_RAW | (1 << 2) | ((size & 0x0F) << 4),
      (size >> 4) & 0xFF
    ]);
  } else if (size <= 1048575) {
    header = Buffer.from([
      c.LITERALS_RAW | (3 << 2) | ((size & 0x0F) << 4),
      (size >> 4) & 0xFF,
      (size >> 12) & 0xFF
    ]);
  } else {
    throw new Error('literals section too large: ' + size);
  }

  return Buffer.concat([header, literals]);
}

/** RLE_Literals_Block: one byte repeated Regenerated_Size times. */
function writeRleLiterals(byte, size) {
  var header;
  if (size <= 31) {
    header = Buffer.from([c.LITERALS_RLE | (0 << 2) | (size << 3)]);
  } else if (size <= 4095) {
    header = Buffer.from([
      c.LITERALS_RLE | (1 << 2) | ((size & 0x0F) << 4),
      (size >> 4) & 0xFF
    ]);
  } else {
    header = Buffer.from([
      c.LITERALS_RLE | (3 << 2) | ((size & 0x0F) << 4),
      (size >> 4) & 0xFF,
      (size >> 12) & 0xFF
    ]);
  }
  return Buffer.concat([header, Buffer.from([byte])]);
}

exports.writeRawLiterals = writeRawLiterals;
exports.writeRleLiterals = writeRleLiterals;
