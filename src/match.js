'use strict';

// LZ77 match finder.
//
// A hash table maps four-byte prefixes to the most recent position holding
// them, and a chain links older positions with the same hash. Searching walks
// that chain and keeps the longest match. Output is a list of sequences, each
// "copy N literals, then repeat M bytes from D back".

var MIN_MATCH = require('./constants').MIN_MATCH;

var HASH_LOG = 16;
var HASH_SIZE = 1 << HASH_LOG;

function hash4(src, at) {
  var v = (src[at] | (src[at + 1] << 8) | (src[at + 2] << 16) | (src[at + 3] << 24)) >>> 0;
  return (Math.imul(v, 2654435761) >>> (32 - HASH_LOG));
}

/**
 * @returns {{sequences: Array, literals: Buffer}} sequences hold
 *   {literalLength, offset, matchLength}; literals is every unmatched byte,
 *   concatenated, which the block stores separately.
 */
function findSequences(src, options) {
  options = options || {};
  var searchDepth = options.searchDepth || 32;
  var windowSize = options.windowSize || (1 << 22);

  var head = new Int32Array(HASH_SIZE).fill(-1);
  var chain = new Int32Array(src.length).fill(-1);

  var sequences = [];
  var literals = Buffer.alloc(src.length);
  var literalCount = 0;

  var anchor = 0;
  var pos = 0;
  var limit = src.length - MIN_MATCH - 1;

  while (pos < limit) {
    var h = hash4(src, pos);
    var candidate = head[h];

    var bestLength = 0;
    var bestOffset = 0;
    var tries = searchDepth;

    while (candidate >= 0 && tries-- > 0) {
      var offset = pos - candidate;
      if (offset > windowSize) break;

      // Cheap rejection before the byte-by-byte compare.
      if (src[candidate + bestLength] === src[pos + bestLength]) {
        var length = 0;
        var max = src.length - pos;
        while (length < max && src[candidate + length] === src[pos + length]) length++;

        if (length > bestLength) {
          bestLength = length;
          bestOffset = offset;
        }
      }
      candidate = chain[candidate];
    }

    if (bestLength >= MIN_MATCH) {
      var literalLength = pos - anchor;
      src.copy(literals, literalCount, anchor, pos);
      literalCount += literalLength;

      sequences.push({
        literalLength: literalLength,
        offset: bestOffset,
        matchLength: bestLength
      });

      // Index every position inside the match so later matches can find them.
      for (var i = pos; i < pos + bestLength && i < limit; i++) {
        var hi = hash4(src, i);
        chain[i] = head[hi];
        head[hi] = i;
      }

      pos += bestLength;
      anchor = pos;
    } else {
      chain[pos] = head[h];
      head[h] = pos;
      pos++;
    }
  }

  // Whatever is left after the final match is trailing literals, which the
  // block emits with no sequence following them.
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
