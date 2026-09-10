'use strict';

var bin = require('./bytes');

// Sequences_Section encoding (RFC 8878 Section 3.1.1.3.2).

var c = require('./constants');
var fse = require('./fse');
var BitWriter = require('./bitstream').BitWriter;
var repcodes = require('./repcodes');
var fseTable = require('./fse-table');

// Predefined tables, built once. Symbol maxima follow the distributions.
var LL_TABLE = fse.buildCTable(c.LL_DEFAULT_DISTRIBUTION, c.LL_DEFAULT_ACCURACY, c.LL_SYMBOL_MAX);
var ML_TABLE = fse.buildCTable(c.ML_DEFAULT_DISTRIBUTION, c.ML_DEFAULT_ACCURACY, c.ML_SYMBOL_MAX);
var OF_TABLE = fse.buildCTable(c.OF_DEFAULT_DISTRIBUTION, c.OF_DEFAULT_ACCURACY, 28);

// The largest offset code the predefined distribution can represent.
var OF_PREDEFINED_MAX = 28;

function codeFor(baselines, value, max) {
  // Baselines ascend, so the code is the last one not exceeding the value.
  for (var i = max; i >= 0; i--) {
    if (value >= baselines[i]) return i;
  }
  return 0;
}

function literalLengthCode(length) {
  return length <= 15 ? length : codeFor(c.LL_BASELINE, length, c.LL_SYMBOL_MAX);
}

function matchLengthCode(length) {
  return length <= 34 ? length - c.MIN_MATCH : codeFor(c.ML_BASELINE, length, c.ML_SYMBOL_MAX);
}

// Section 3.1.1.3.2: Offset_Value = (1 << code) + extra bits, and values 1-3
// are reserved for repeat offsets, so a literal offset is stored plus three.
function offsetCode(offset) {
  return fse.highBit(offset + 3);
}

// Section 3.1.1.3.2: Number_of_Sequences is 1 to 3 bytes.
function writeSequenceCount(count) {
  if (count < 128) return bin.from([count]);
  if (count < 0x7F00) return bin.from([(count >> 8) + 128, count & 0xFF]);
  var rest = count - 0x7F00;
  return bin.from([255, rest & 0xFF, (rest >> 8) & 0xFF]);
}

/**
 * Encode sequences using the predefined FSE distributions.
 *
 * @param {Array} sequences
 * @param {number[]} reps repeat-offset history entering this block
 * @returns {{section: Buffer, reps: number[]}|null} null when these sequences
 *   cannot be represented with the predefined tables.
 */
function encodeSequences(sequences, reps) {
  reps = reps || repcodes.INITIAL.slice();

  if (sequences.length === 0) {
    return { section: bin.from([0]), reps: reps };
  }

  var count = sequences.length;
  var llCodes = new Uint8Array(count);
  var mlCodes = new Uint8Array(count);
  var ofCodes = new Uint8Array(count);
  var offBases = new Uint32Array(count);

  // Offsets resolve in forward order, because each one depends on the history
  // left by the sequences before it.
  var history = reps.slice();
  for (var i = 0; i < count; i++) {
    var s = sequences[i];

    if (s.literalLength > 131071 || s.matchLength > 131074) return null;

    var resolved = repcodes.resolve(s.offset, s.literalLength, history);
    history = resolved.reps;

    offBases[i] = resolved.offBase;
    llCodes[i] = literalLengthCode(s.literalLength);
    mlCodes[i] = matchLengthCode(s.matchLength);
    ofCodes[i] = fse.highBit(resolved.offBase);

    if (ofCodes[i] > OF_PREDEFINED_MAX) return null;
  }

  // Choose how each symbol type is coded. A custom table costs bytes to
  // transmit, so it only pays once there are enough sequences to amortise it.
  var ll = chooseMode(llCodes, c.LL_SYMBOL_MAX, c.LL_FSE_ACCURACY_MAX, LL_TABLE, c.LL_DEFAULT_DISTRIBUTION, count);
  var of = chooseMode(ofCodes, c.OF_SYMBOL_MAX, c.OF_FSE_ACCURACY_MAX, OF_TABLE, c.OF_DEFAULT_DISTRIBUTION, count);
  var ml = chooseMode(mlCodes, c.ML_SYMBOL_MAX, c.ML_FSE_ACCURACY_MAX, ML_TABLE, c.ML_DEFAULT_DISTRIBUTION, count);

  var writer = new BitWriter(1024);

  var llState = new fse.FseState(ll.table);
  var mlState = new fse.FseState(ml.table);
  var ofState = new fse.FseState(of.table);

  // The decoder reads backward, so encode from the last sequence to the
  // first. States are seeded from the last sequence's symbols.
  var last = count - 1;
  mlState.init(mlCodes[last]);
  ofState.init(ofCodes[last]);
  llState.init(llCodes[last]);

  writeExtras(writer, sequences[last], offBases[last], llCodes[last], mlCodes[last], ofCodes[last]);

  for (var n = count - 2; n >= 0; n--) {
    ofState.encode(writer, ofCodes[n]);
    mlState.encode(writer, mlCodes[n]);
    llState.encode(writer, llCodes[n]);
    writeExtras(writer, sequences[n], offBases[n], llCodes[n], mlCodes[n], ofCodes[n]);
  }

  // Final states, in the order the decoder will read them back.
  mlState.flush(writer);
  ofState.flush(writer);
  llState.flush(writer);

  var bitstream = writer.close();

  // Section 3.1.1.3.2.1: modes pack as literal lengths, offsets, match
  // lengths; the low two bits are reserved and must be zero.
  var modes = bin.from([(ll.mode << 6) | (of.mode << 4) | (ml.mode << 2)]);

  // Tables follow the header in the order literal lengths, offsets, match
  // lengths.
  var parts = [writeSequenceCount(count), modes];
  if (ll.description) parts.push(ll.description);
  if (of.description) parts.push(of.description);
  if (ml.description) parts.push(ml.description);
  parts.push(bitstream);

  return { section: bin.concat(parts), reps: history };
}

// Sequence count below which a transmitted table cannot pay for itself.
var CUSTOM_TABLE_MIN_SEQUENCES = 24;

/**
 * Decide between Predefined_Mode, RLE_Mode and FSE_Compressed_Mode for one
 * symbol type.
 */
function chooseMode(codes, maxSymbol, maxAccuracyLog, predefinedTable, predefinedDistribution, count) {
  var counts = new Uint32Array(maxSymbol + 1);
  var distinct = 0;
  for (var i = 0; i < codes.length; i++) {
    if (counts[codes[i]]++ === 0) distinct++;
  }

  // One symbol throughout: the table is that single value.
  if (distinct === 1) {
    var only = codes[0];
    return {
      mode: c.MODE_RLE,
      description: bin.from([only]),
      table: rleTable(only, maxSymbol)
    };
  }

  // Price a transmitted table against the predefined distribution rather than
  // assuming either is better. A custom table has to pay for itself.
  var custom = count >= CUSTOM_TABLE_MIN_SEQUENCES
    ? fseTable.buildCustom(counts, maxSymbol, maxAccuracyLog, count)
    : null;

  if (custom !== null) {
    var predefinedBits = fseTable.estimateBits(counts, predefinedDistribution, maxSymbol, predefinedTable.accuracyLog);
    if (custom.bits < predefinedBits) {
      return { mode: c.MODE_FSE, description: custom.description, table: custom.table };
    }
  }

  return { mode: c.MODE_PREDEFINED, description: null, table: predefinedTable };
}

// RLE_Mode still needs a table to drive the encoder, even though the stream
// carries no bits for this symbol type.
function rleTable(symbol, maxSymbol) {
  var distribution = new Int16Array(maxSymbol + 1);
  distribution[symbol] = 1;
  return fse.buildCTable(distribution, 0, symbol);
}

// Extra bits carry the offset of a value above its code's baseline.
function writeExtras(writer, seq, offBase, llCode, mlCode, ofCode) {
  writer.addBits(seq.literalLength - c.LL_BASELINE[llCode], c.LL_BITS[llCode]);
  writer.addBits(seq.matchLength - c.ML_BASELINE[mlCode], c.ML_BITS[mlCode]);
  writer.addBits(offBase - Math.pow(2, ofCode), ofCode);
}

exports.encodeSequences = encodeSequences;
exports.resolveOffset = repcodes.resolve;
exports.literalLengthCode = literalLengthCode;
exports.matchLengthCode = matchLengthCode;
exports.offsetCode = offsetCode;
exports.writeSequenceCount = writeSequenceCount;
exports.OF_PREDEFINED_MAX = OF_PREDEFINED_MAX;
