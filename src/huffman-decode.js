'use strict';

// Huffman decoding for literals (RFC 8878 Section 4.2).

var fse = require('./fse');
var fseDecode = require('./fse-decode');
var BitReader = require('./bitstream').BitReader;

/**
 * Read a Huffman_Tree_Description.
 * @returns {{nbBits: Uint8Array, maxBits: number, size: number}}
 */
function readTreeDescription(bytes, offset) {
  var headerByte = bytes[offset];
  var weights = new Uint8Array(256);
  var described;
  var size;

  if (headerByte >= 128) {
    // Direct representation: 4-bit weights, two per byte, high nibble first.
    described = headerByte - 127;
    var weightBytes = (described + 1) >> 1;
    for (var i = 0; i < described; i++) {
      var byte = bytes[offset + 1 + (i >> 1)];
      weights[i] = (i & 1) === 0 ? (byte >> 4) : (byte & 0x0F);
    }
    size = 1 + weightBytes;
  } else {
    var decoded = readFseWeights(bytes, offset + 1, headerByte);
    weights = decoded.weights;
    described = decoded.count;
    size = 1 + headerByte;
  }

  // The final symbol's weight is whatever completes the total to a power of
  // two (Section 4.2.1).
  var total = 0;
  for (var s = 0; s < described; s++) {
    if (weights[s] > 0) total += 1 << (weights[s] - 1);
  }
  if (total === 0) throw new Error('Huffman tree describes no symbols');

  var maxBits = fse.highBit(total) + 1;
  var leftover = (1 << maxBits) - total;
  if (leftover <= 0 || (leftover & (leftover - 1)) !== 0) {
    throw new Error('Huffman weights do not complete to a power of two');
  }
  weights[described] = fse.highBit(leftover) + 1;

  var nbBits = new Uint8Array(256);
  for (var t = 0; t <= described; t++) {
    nbBits[t] = weights[t] === 0 ? 0 : maxBits + 1 - weights[t];
  }

  return { nbBits: nbBits, maxBits: maxBits, size: size };
}

/**
 * Weights compressed with FSE, using two states that share one table and
 * take turns (Section 4.2.1.2).
 */
function readFseWeights(bytes, offset, compressedSize) {
  var description = fseDecode.readTableDescription(bytes, offset, 255, 6);
  var table = fseDecode.buildDTable(description.normalized, description.accuracyLog, description.maxSymbol);

  var streamStart = offset + description.size;
  var streamEnd = offset + compressedSize;
  var reader = new BitReader(bytes.subarray(streamStart, streamEnd));

  var state1 = reader.readBits(table.accuracyLog);
  var state2 = reader.readBits(table.accuracyLog);

  var weights = new Uint8Array(256);
  var count = 0;

  // Section 4.2.1.2: the two states take turns. Bits past the end of the
  // stream count as zero, and the read that overruns ends the series after
  // one final symbol from the other state.
  function advance(state) {
    var bits = table.bits[state];
    var next = table.base[state] + reader.peek(bits);
    reader.skip(bits);
    return next;
  }

  function overrun() {
    return reader.remaining() < 0;
  }

  for (;;) {
    if (count > 253) throw new Error('too many Huffman weights');

    weights[count++] = table.symbol[state1];
    state1 = advance(state1);
    if (overrun()) {
      weights[count++] = table.symbol[state2];
      break;
    }

    weights[count++] = table.symbol[state2];
    state2 = advance(state2);
    if (overrun()) {
      weights[count++] = table.symbol[state1];
      break;
    }
  }

  return { weights: weights, count: count };
}

/**
 * Table mapping the next `maxBits` of the stream to a symbol and its length.
 *
 * A code sits in the high bits of that window, so every window sharing the
 * code's prefix maps to the same symbol.
 */
function buildDecodeTable(nbBits, maxBits) {
  var size = 1 << maxBits;
  var symbol = new Uint8Array(size);
  var bits = new Uint8Array(size);

  // Canonical assignment, longest codes first, matching the encoder.
  var code = 0;
  for (var length = maxBits; length >= 1; length--) {
    for (var s = 0; s < 256; s++) {
      if (nbBits[s] !== length) continue;

      var span = 1 << (maxBits - length);
      var start = code * span;
      for (var i = 0; i < span; i++) {
        symbol[start + i] = s;
        bits[start + i] = length;
      }
      code++;
    }
    code >>= 1;
  }

  return { symbol: symbol, bits: bits, maxBits: maxBits };
}

/**
 * Decode `count` symbols from one stream.
 *
 * This is the hottest loop in decompression, so the bit extraction is inlined
 * rather than going through BitReader: a code is at most 11 bits, so a 32-bit
 * word always spans the window plus its offset. Positions near the start of
 * the stream fall back to the reader, which pads with zeros.
 */
function decodeStream(bytes, table, count, out, outOffset) {
  var reader = new BitReader(bytes);
  var position = reader.pos;

  var maxBits = table.maxBits;
  var mask = (1 << maxBits) - 1;
  var symbols = table.symbol;
  var lengths = table.bits;
  var fastLimit = bytes.length - 4;

  for (var i = 0; i < count; i++) {
    var low = position - maxBits + 1;
    var index;

    var byteIndex = low >> 3;
    if (low >= 0 && byteIndex <= fastLimit) {
      var word = bytes[byteIndex] |
        (bytes[byteIndex + 1] << 8) |
        (bytes[byteIndex + 2] << 16) |
        (bytes[byteIndex + 3] << 24);
      index = (word >>> (low & 7)) & mask;
    } else {
      reader.pos = position;
      index = reader.peek(maxBits);
    }

    var length = lengths[index];
    if (length === 0) throw new Error('invalid Huffman code in literals stream');

    out[outOffset + i] = symbols[index];
    position -= length;
  }

  return count;
}

exports.readTreeDescription = readTreeDescription;
exports.buildDecodeTable = buildDecodeTable;
exports.decodeStream = decodeStream;
