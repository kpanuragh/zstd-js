'use strict';

// Sequences_Section encoding (RFC 8878 Section 3.1.1.3.2).

var c = require('./constants');
var fse = require('./fse');
var BitWriter = require('./bitstream').BitWriter;

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
  if (count < 128) return Buffer.from([count]);
  if (count < 0x7F00) return Buffer.from([(count >> 8) + 128, count & 0xFF]);
  var rest = count - 0x7F00;
  return Buffer.from([255, rest & 0xFF, (rest >> 8) & 0xFF]);
}

/**
 * Resolve an actual offset against the repeat-offset history.
 *
 * Section 3.1.1.5: Offset_Values 1-3 name recently used offsets instead of
 * spelling one out, which is far cheaper. When a sequence has no literals the
 * three slots shift, and code 3 then means "most recent offset minus one".
 *
 * @returns {{offBase: number, reps: number[]}} offBase is 1-3 for a repeat,
 *   or offset + 3 for a literal offset.
 */
function resolveOffset(offset, literalLength, reps) {
  var ll0 = literalLength === 0 ? 1 : 0;

  for (var code = 1; code <= 3; code++) {
    var index = code - 1 + ll0;
    var candidate = index === 3 ? reps[0] - 1 : reps[index];
    if (candidate === offset && candidate > 0) {
      return { offBase: code, reps: updateReps(reps, code, ll0) };
    }
  }

  return { offBase: offset + 3, reps: [offset, reps[0], reps[1]] };
}

// Mirror of the decoder's history update for a repeat code.
function updateReps(reps, code, ll0) {
  var index = code - 1 + ll0;
  if (index === 0) return reps.slice();

  var current = index === 3 ? reps[0] - 1 : reps[index];
  return [current, reps[0], index >= 2 ? reps[1] : reps[2]];
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
  reps = reps || c.REPEAT_OFFSETS.slice();

  if (sequences.length === 0) {
    return { section: Buffer.from([0]), reps: reps };
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

    var resolved = resolveOffset(s.offset, s.literalLength, history);
    history = resolved.reps;

    offBases[i] = resolved.offBase;
    llCodes[i] = literalLengthCode(s.literalLength);
    mlCodes[i] = matchLengthCode(s.matchLength);
    ofCodes[i] = fse.highBit(resolved.offBase);

    if (ofCodes[i] > OF_PREDEFINED_MAX) return null;
  }

  var writer = new BitWriter(1024);

  var llState = new fse.FseState(LL_TABLE);
  var mlState = new fse.FseState(ML_TABLE);
  var ofState = new fse.FseState(OF_TABLE);

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

  // All three symbol types use Predefined_Mode; the low two bits are reserved.
  var modes = Buffer.from([
    (c.MODE_PREDEFINED << 6) | (c.MODE_PREDEFINED << 4) | (c.MODE_PREDEFINED << 2)
  ]);

  return {
    section: Buffer.concat([writeSequenceCount(count), modes, bitstream]),
    reps: history
  };
}

// Extra bits carry the offset of a value above its code's baseline.
function writeExtras(writer, seq, offBase, llCode, mlCode, ofCode) {
  writer.addBits(seq.literalLength - c.LL_BASELINE[llCode], c.LL_BITS[llCode]);
  writer.addBits(seq.matchLength - c.ML_BASELINE[mlCode], c.ML_BITS[mlCode]);
  writer.addBits(offBase - Math.pow(2, ofCode), ofCode);
}

exports.encodeSequences = encodeSequences;
exports.resolveOffset = resolveOffset;
exports.literalLengthCode = literalLengthCode;
exports.matchLengthCode = matchLengthCode;
exports.offsetCode = offsetCode;
exports.writeSequenceCount = writeSequenceCount;
exports.OF_PREDEFINED_MAX = OF_PREDEFINED_MAX;
