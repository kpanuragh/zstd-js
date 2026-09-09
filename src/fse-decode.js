'use strict';

// FSE decoding: reading a table description and building a decoding table
// (RFC 8878 Section 4.1).

var fse = require('./fse');

/**
 * Read a table description from `bytes` starting at `offset`.
 * @returns {{normalized: Int16Array, maxSymbol: number, accuracyLog: number, size: number}}
 */
function readTableDescription(bytes, offset, maxSymbolAllowed, maxAccuracyLog) {
  var bitPosition = 0;
  var start = offset;

  function peek(count) {
    var value = 0;
    for (var i = 0; i < count; i++) {
      var index = bitPosition + i;
      var byte = bytes[offset + (index >> 3)];
      if (byte === undefined) byte = 0;
      value |= ((byte >> (index & 7)) & 1) << i;
    }
    return value;
  }

  function take(count) {
    var value = peek(count);
    bitPosition += count;
    return value;
  }

  var accuracyLog = take(4) + 5;
  if (accuracyLog > maxAccuracyLog) throw new Error('FSE accuracy log too large: ' + accuracyLog);

  var tableSize = 1 << accuracyLog;
  var normalized = new Int16Array(maxSymbolAllowed + 1);

  var remaining = tableSize + 1;
  var threshold = tableSize;
  var nbBits = accuracyLog + 1;
  var symbol = 0;

  while (remaining > 1 && symbol <= maxSymbolAllowed) {
    var max = (2 * threshold - 1) - remaining;
    var value;

    var low = peek(nbBits - 1);
    if (max > 0 && low < max) {
      bitPosition += nbBits - 1;
      value = low;
    } else {
      value = take(nbBits);
      if (value >= threshold) value -= max;
    }

    var probability = value - 1;
    normalized[symbol++] = probability;
    remaining -= probability < 0 ? -probability : probability;

    if (probability === 0) {
      // A zero is followed by 2-bit repeat codes counting further zeroes.
      for (;;) {
        var repeat = take(2);
        symbol += repeat;
        if (repeat !== 3) break;
      }
      if (symbol > maxSymbolAllowed + 1) throw new Error('FSE table overran its alphabet');
    }

    while (remaining < threshold) {
      nbBits--;
      threshold >>= 1;
    }
  }

  return {
    normalized: normalized,
    maxSymbol: symbol - 1,
    accuracyLog: accuracyLog,
    size: (bitPosition + 7) >> 3
  };
}

/**
 * Build a decoding table.
 *
 * Symbols are spread exactly as the encoder spreads them, then each state
 * records which symbol it yields, how many bits to read next, and the base
 * the next state is computed from.
 */
function buildDTable(normalized, accuracyLog, maxSymbol) {
  var tableSize = 1 << accuracyLog;
  var tableMask = tableSize - 1;
  var step = fse.tableStep(tableSize);

  var symbols = new Uint8Array(tableSize);
  var highThreshold = tableSize - 1;

  for (var s = 0; s <= maxSymbol; s++) {
    if (normalized[s] === -1) symbols[highThreshold--] = s;
  }

  var position = 0;
  for (var sym = 0; sym <= maxSymbol; sym++) {
    for (var n = 0; n < normalized[sym]; n++) {
      symbols[position] = sym;
      position = (position + step) & tableMask;
      while (position > highThreshold) position = (position + step) & tableMask;
    }
  }

  var nextCount = new Uint32Array(maxSymbol + 1);
  for (var t = 0; t <= maxSymbol; t++) {
    nextCount[t] = normalized[t] === -1 ? 1 : normalized[t];
  }

  var symbolOf = new Uint8Array(tableSize);
  var bitsOf = new Uint8Array(tableSize);
  var baseOf = new Uint16Array(tableSize);

  for (var u = 0; u < tableSize; u++) {
    var symbolHere = symbols[u];
    var next = nextCount[symbolHere]++;
    var bits = accuracyLog - fse.highBit(next);

    symbolOf[u] = symbolHere;
    bitsOf[u] = bits;
    baseOf[u] = ((next << bits) - tableSize) & 0xFFFF;
  }

  return {
    accuracyLog: accuracyLog,
    symbol: symbolOf,
    bits: bitsOf,
    base: baseOf
  };
}

/** A table where every state yields the same symbol and consumes no bits. */
function rleDTable(symbol) {
  return {
    accuracyLog: 0,
    symbol: Uint8Array.from([symbol]),
    bits: Uint8Array.from([0]),
    base: Uint16Array.from([0])
  };
}

exports.readTableDescription = readTableDescription;
exports.buildDTable = buildDTable;
exports.rleDTable = rleDTable;
