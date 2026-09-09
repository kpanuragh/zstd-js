'use strict';

// Normalising symbol counts and writing FSE table descriptions
// (RFC 8878 Section 4.1.1).

var fse = require('./fse');

/**
 * Pick an accuracy log with enough states to give every present symbol at
 * least one, plus headroom for the frequent ones.
 */
function chooseAccuracyLog(distinctSymbols, maxLog) {
  var log = 5;
  while ((1 << log) < distinctSymbols * 2 && log < maxLog) log++;
  return log;
}

/**
 * Scale raw counts onto 2^accuracyLog, giving every present symbol at least
 * one state so the table stays usable.
 *
 * @returns {Int16Array|null} null if the alphabet does not fit the table.
 */
function normalize(counts, maxSymbol, accuracyLog) {
  var tableSize = 1 << accuracyLog;

  var total = 0;
  var present = 0;
  for (var s = 0; s <= maxSymbol; s++) {
    total += counts[s];
    if (counts[s] > 0) present++;
  }
  if (total === 0 || present > tableSize) return null;

  var normalized = new Int16Array(maxSymbol + 1);
  var distributed = 0;
  var largest = -1;

  for (var i = 0; i <= maxSymbol; i++) {
    if (counts[i] === 0) continue;

    var share = Math.floor((counts[i] * tableSize) / total);
    if (share < 1) share = 1;
    normalized[i] = share;
    distributed += share;

    if (largest === -1 || counts[i] > counts[largest]) largest = i;
  }

  // Settle the rounding error on the most frequent symbol, which can absorb
  // it with the least distortion.
  var slack = tableSize - distributed;
  if (slack !== 0) {
    normalized[largest] += slack;

    // If that overshoots, take the excess from whatever else can spare it.
    while (normalized[largest] < 1) {
      var donor = -1;
      for (var d = 0; d <= maxSymbol; d++) {
        if (d !== largest && normalized[d] > 1 && (donor === -1 || normalized[d] > normalized[donor])) donor = d;
      }
      if (donor === -1) return null;
      normalized[donor]--;
      normalized[largest]++;
    }
  }

  var check = 0;
  for (var v = 0; v <= maxSymbol; v++) check += normalized[v];
  if (check !== tableSize) return null;

  return normalized;
}

/**
 * Write the table description.
 *
 * The field width shrinks as probability points are used up, and small values
 * within a field use one bit fewer. Runs of zero-probability symbols are
 * followed by 2-bit repeat codes.
 */
function writeTableDescription(normalized, maxSymbol, accuracyLog) {
  var bits = [];
  var bitCount = 0;
  var accumulator = 0;

  function push(value, count) {
    accumulator |= (value & ((1 << count) - 1)) << bitCount;
    bitCount += count;
    while (bitCount >= 8) {
      bits.push(accumulator & 0xFF);
      accumulator >>>= 8;
      bitCount -= 8;
    }
  }

  push(accuracyLog - 5, 4);

  var tableSize = 1 << accuracyLog;
  var remaining = tableSize + 1;
  var threshold = tableSize;
  var nbBits = accuracyLog + 1;

  var symbol = 0;
  var last = maxSymbol;
  while (last > 0 && normalized[last] === 0) last--;

  while (symbol <= last && remaining > 1) {
    var probability = normalized[symbol];
    var value = probability + 1; // -1 becomes 0, 0 becomes 1
    var max = (2 * threshold - 1) - remaining;

    if (max > 0 && value < max) {
      push(value, nbBits - 1);
    } else if (value < threshold) {
      push(value, nbBits);
    } else {
      push(value + max, nbBits);
    }

    remaining -= probability < 0 ? -probability : probability;
    symbol++;

    // A zero probability is followed by a repeat count of further zeroes.
    if (probability === 0) {
      var run = 0;
      while (symbol <= last && normalized[symbol] === 0) { run++; symbol++; }
      while (run >= 3) { push(3, 2); run -= 3; }
      push(run, 2);
    }

    while (remaining < threshold) {
      nbBits--;
      threshold >>= 1;
    }
  }

  if (bitCount > 0) bits.push(accumulator & 0xFF);
  return Buffer.from(bits);
}

/**
 * Build everything needed to encode one symbol stream with a custom table.
 * @returns {{table: object, description: Buffer}|null}
 */
function buildCustom(counts, maxSymbol, maxAccuracyLog) {
  var distinct = 0;
  for (var s = 0; s <= maxSymbol; s++) if (counts[s] > 0) distinct++;

  // The format requires at least two symbols with nonzero probability;
  // a single symbol is expressed with RLE mode instead.
  if (distinct < 2) return null;

  var accuracyLog = chooseAccuracyLog(distinct, maxAccuracyLog);
  var normalized = normalize(counts, maxSymbol, accuracyLog);
  if (normalized === null) return null;

  var highest = maxSymbol;
  while (highest > 0 && normalized[highest] === 0) highest--;

  return {
    table: fse.buildCTable(normalized, accuracyLog, highest),
    description: writeTableDescription(normalized, maxSymbol, accuracyLog),
    accuracyLog: accuracyLog
  };
}

exports.normalize = normalize;
exports.writeTableDescription = writeTableDescription;
exports.chooseAccuracyLog = chooseAccuracyLog;
exports.buildCustom = buildCustom;
