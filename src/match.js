'use strict';

// LZ77 match finder.
//
// A hash table maps four-byte prefixes to the most recent position holding
// them, and a chain links older positions with the same hash. Two things
// beyond a plain greedy search matter for ratio:
//
//   - Recently used offsets are tried first, because encoding one costs a
//     couple of bits where a spelled-out offset costs a dozen or more.
//   - Matching is lazy: after finding a match we check whether starting one
//     byte later would do meaningfully better, and if so emit a literal and
//     take the later match instead.

var MIN_MATCH = require('./constants').MIN_MATCH;
var repcodes = require('./repcodes');

// Match length a repeat offset is worth giving up, in bytes.
var REPEAT_BIAS = 4;

// How much longer a later match must be before we skip a byte for it.
var LAZY_MARGIN = 1;

var HASH_LOG = 16;
var HASH_SIZE = 1 << HASH_LOG;

function hash4(src, at) {
  var v = (src[at] | (src[at + 1] << 8) | (src[at + 2] << 16) | (src[at + 3] << 24)) >>> 0;
  return (Math.imul(v, 2654435761) >>> (32 - HASH_LOG));
}

function findSequences(src, options) {
  options = options || {};
  var searchDepth = options.searchDepth || 32;
  var windowSize = options.windowSize || (1 << 22);
  var reps = (options.reps || repcodes.INITIAL).slice();

  var head = new Int32Array(HASH_SIZE).fill(-1);
  var chain = new Int32Array(src.length).fill(-1);

  var sequences = [];
  var literals = Buffer.alloc(src.length);
  var literalCount = 0;

  var anchor = 0;
  var pos = 0;
  var limit = src.length - MIN_MATCH - 1;

  // Longest match reachable from `at`, considering repeat offsets and the
  // hash chain. Returns length 0 when nothing usable is found.
  function bestMatchAt(at, literalLength) {
    var ll0 = literalLength === 0 ? 1 : 0;
    var max = src.length - at;

    var repLength = 0;
    var repOffset = 0;
    for (var code = 1; code <= 3; code++) {
      var candidateOffset = repcodes.offsetForCode(code, reps, ll0);
      if (candidateOffset <= 0 || candidateOffset > at) continue;

      var repLen = 0;
      var from = at - candidateOffset;
      while (repLen < max && src[from + repLen] === src[at + repLen]) repLen++;

      if (repLen > repLength) {
        repLength = repLen;
        repOffset = candidateOffset;
      }
    }

    var bestLength = 0;
    var bestOffset = 0;
    var candidate = head[hash4(src, at)];
    var tries = searchDepth;

    while (candidate >= 0 && tries-- > 0) {
      var offset = at - candidate;
      if (offset > windowSize) break;

      // Cheap rejection: the byte past the current best must match.
      if (src[candidate + bestLength] === src[at + bestLength]) {
        var length = 0;
        while (length < max && src[candidate + length] === src[at + length]) length++;
        if (length > bestLength) {
          bestLength = length;
          bestOffset = offset;
        }
      }
      candidate = chain[candidate];
    }

    if (repLength >= MIN_MATCH && repLength + REPEAT_BIAS >= bestLength) {
      return { length: repLength, offset: repOffset };
    }
    return { length: bestLength, offset: bestOffset };
  }

  function insert(at) {
    var h = hash4(src, at);
    chain[at] = head[h];
    head[h] = at;
  }

  while (pos < limit) {
    var found = bestMatchAt(pos, pos - anchor);

    if (found.length < MIN_MATCH) {
      insert(pos);
      pos++;
      continue;
    }

    // Lazy step: would starting one byte later pay for the extra literal?
    while (pos + 1 < limit) {
      insert(pos);
      var next = bestMatchAt(pos + 1, pos + 1 - anchor);
      if (next.length >= found.length + LAZY_MARGIN) {
        found = next;
        pos++;
      } else {
        break;
      }
    }

    var literalLength = pos - anchor;
    src.copy(literals, literalCount, anchor, pos);
    literalCount += literalLength;

    sequences.push({
      literalLength: literalLength,
      offset: found.offset,
      matchLength: found.length
    });

    reps = repcodes.resolve(found.offset, literalLength, reps).reps;

    // Index every position inside the match so later searches can reach them.
    for (var i = pos; i < pos + found.length && i < limit; i++) insert(i);

    pos += found.length;
    anchor = pos;
  }

  // Anything after the final match is trailing literals with no sequence.
  var tail = src.length - anchor;
  if (tail > 0) {
    src.copy(literals, literalCount, anchor, src.length);
    literalCount += tail;
  }

  return {
    sequences: sequences,
    literals: literals.subarray(0, literalCount),
    lastLiteralLength: tail
  };
}

exports.findSequences = findSequences;
exports.hash4 = hash4;
