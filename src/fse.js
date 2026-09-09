'use strict';

// Finite State Entropy encoder (RFC 8878 Section 4.1).
//
// FSE assigns each symbol a set of states in a table of size 2^accuracyLog,
// proportional to the symbol's normalised frequency. Encoding a symbol emits
// some low bits of the current state and transitions to a new state. Because
// the decoder walks the bitstream backward, symbols must be encoded in
// reverse order and the final states flushed at the end.

// Distance between successive slots when spreading symbols over the table.
// Chosen so the walk visits every slot exactly once.
function tableStep(tableSize) {
  return (tableSize >> 1) + (tableSize >> 3) + 3;
}

/**
 * Build an encoding table from a normalised distribution.
 *
 * A count of -1 marks a "less than one" probability: the symbol is reachable
 * but costs the most bits, and it is placed in the high slots of the table.
 */
function buildCTable(normalized, accuracyLog, maxSymbol) {
  var tableSize = 1 << accuracyLog;
  var tableMask = tableSize - 1;
  var step = tableStep(tableSize);

  var tableSymbol = new Uint8Array(tableSize);
  var highThreshold = tableSize - 1;

  // Low-probability symbols occupy the top of the table, filled downward.
  for (var s = 0; s <= maxSymbol; s++) {
    if (normalized[s] === -1) tableSymbol[highThreshold--] = s;
  }

  // Everything else is spread across the remaining slots.
  var position = 0;
  for (var symbol = 0; symbol <= maxSymbol; symbol++) {
    var freq = normalized[symbol];
    for (var n = 0; n < freq; n++) {
      tableSymbol[position] = symbol;
      position = (position + step) & tableMask;
      while (position > highThreshold) position = (position + step) & tableMask;
    }
  }

  // Cumulative start index per symbol; a -1 count contributes one slot.
  var cumul = new Uint32Array(maxSymbol + 2);
  for (var u = 1; u <= maxSymbol + 1; u++) {
    cumul[u] = cumul[u - 1] + (normalized[u - 1] === -1 ? 1 : normalized[u - 1]);
  }

  var nextState = new Uint16Array(tableSize);
  var cursor = Uint32Array.from(cumul);
  for (var i = 0; i < tableSize; i++) {
    var sym = tableSymbol[i];
    nextState[cursor[sym]++] = tableSize + i;
  }

  // Per-symbol transform. deltaNbBits packs the bit count so that
  // (state + deltaNbBits) >> 16 yields how many bits to emit.
  var deltaNbBits = new Int32Array(maxSymbol + 1);
  var deltaFindState = new Int32Array(maxSymbol + 1);
  var total = 0;

  for (var t = 0; t <= maxSymbol; t++) {
    var count = normalized[t];
    if (count === 0) {
      // Unused symbol: encoding one is a bug, but keep the slot well-formed.
      deltaNbBits[t] = ((accuracyLog + 1) << 16) - (1 << accuracyLog);
    } else if (count === -1 || count === 1) {
      deltaNbBits[t] = (accuracyLog << 16) - (1 << accuracyLog);
      deltaFindState[t] = total - 1;
      total += 1;
    } else {
      var maxBitsOut = accuracyLog - highBit(count - 1);
      var minStatePlus = count << maxBitsOut;
      deltaNbBits[t] = (maxBitsOut << 16) - minStatePlus;
      deltaFindState[t] = total - count;
      total += count;
    }
  }

  return {
    accuracyLog: accuracyLog,
    maxSymbol: maxSymbol,
    nextState: nextState,
    deltaNbBits: deltaNbBits,
    deltaFindState: deltaFindState
  };
}

function highBit(value) {
  return 31 - Math.clz32(value);
}

/** Encoder state for one symbol stream. */
function FseState(table) {
  this.table = table;
  this.value = 0;
}

// Seed the state from the first symbol encoded, which is the last symbol the
// decoder will read.
FseState.prototype.init = function (symbol) {
  var t = this.table;
  var nbBitsOut = (t.deltaNbBits[symbol] + (1 << 15)) >> 16;
  var value = (nbBitsOut << 16) - t.deltaNbBits[symbol];
  this.value = t.nextState[(value >>> nbBitsOut) + t.deltaFindState[symbol]];
};

FseState.prototype.encode = function (writer, symbol) {
  var t = this.table;
  var nbBitsOut = (this.value + t.deltaNbBits[symbol]) >> 16;
  writer.addBits(this.value, nbBitsOut);
  this.value = t.nextState[(this.value >>> nbBitsOut) + t.deltaFindState[symbol]];
};

// Write the final state so the decoder can start from it.
FseState.prototype.flush = function (writer) {
  writer.addBits(this.value, this.table.accuracyLog);
};

exports.buildCTable = buildCTable;
exports.FseState = FseState;
exports.tableStep = tableStep;
exports.highBit = highBit;
