'use strict';

var bin = require('./bytes');

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

// A match this long is already worth taking. Searching past it costs more
// than the handful of bytes a longer one might save.
var GOOD_ENOUGH = 64;

// Consecutive candidates that fail the first-byte check before the position
// is written off. Chain links are scattered in memory, so walking them is
// what dominates compression; giving up after a run of misses buys a fifth of
// the time back for four hundredths of a percent of size.
var MAX_MISSES = 16;

var HASH_LOG = 18;
var HASH_SIZE = 1 << HASH_LOG;

function hash4(src, at) {
  var v = (src[at] | (src[at + 1] << 8) | (src[at + 2] << 16) | (src[at + 3] << 24)) >>> 0;
  return (Math.imul(v, 2654435761) >>> (32 - HASH_LOG));
}

/**
 * Searches one buffer, keeping its index between calls so a later block can
 * match against data in an earlier one.
 */
function MatchFinder(src, options) {
  options = options || {};
  this.src = src;
  this.searchDepth = options.searchDepth || 32;
  this.windowSize = options.windowSize || (1 << 22);
  this.goodEnough = options.goodEnough || GOOD_ENOUGH;
  this.maxMisses = options.maxMisses || MAX_MISSES;
  this.head = new Int32Array(HASH_SIZE).fill(-1);
  this.chain = new Int32Array(src.length).fill(-1);
}

/**
 * Find sequences covering src[start, end).
 *
 * Matches may reach back before `start`, into blocks already emitted, which
 * is what makes a large input compress as one stream rather than as a series
 * of independent blocks.
 */
/**
 * Index everything before `upTo` without emitting sequences for it, so those
 * bytes are reachable as match sources. Used for dictionary content.
 */
MatchFinder.prototype.prime = function (upTo) {
  return this.index(0, upTo);
};

/**
 * Index a range without searching it.
 *
 * A block skipped as incompressible still has to go into the index, or a
 * later block that does repeat it would find nothing to match against.
 */
MatchFinder.prototype.index = function (from, to) {
  var limit = Math.min(to, this.src.length - MIN_MATCH - 1);
  for (var i = from; i < limit; i++) {
    var h = hash4(this.src, i);
    this.chain[i] = this.head[h];
    this.head[h] = i;
  }
  return this;
};

MatchFinder.prototype.run = function (start, end, reps) {
  return search(this.src, start, end, this.head, this.chain,
    this.searchDepth, this.windowSize, (reps || repcodes.INITIAL).slice(),
    this.goodEnough, this.maxMisses);
};

/** Convenience wrapper for compressing a standalone buffer. */
function findSequences(src, options) {
  options = options || {};
  var finder = new MatchFinder(src, options);
  return finder.run(0, src.length, options.reps);
}

// Scratch for the match search. Returning a pair from a function that runs
// once per input byte allocated more than the search itself cost, so the
// result is written here instead.
var foundLength = 0;
var foundOffset = 0;

/** Length of the common prefix at `a` and `b`, up to `max` bytes. */
function commonPrefix(src, a, b, max) {
  var i = 0;
  // Compare a word at a time while there is room, then finish byte-wise.
  while (i + 4 <= max &&
         src[a + i] === src[b + i] &&
         src[a + i + 1] === src[b + i + 1] &&
         src[a + i + 2] === src[b + i + 2] &&
         src[a + i + 3] === src[b + i + 3]) {
    i += 4;
  }
  while (i < max && src[a + i] === src[b + i]) i++;
  return i;
}

/**
 * Best match reachable from `at`, written into foundLength/foundOffset.
 *
 * Recently used offsets are tried first, and a slightly shorter match at one
 * of them wins, because a repeat code costs a couple of bits where a
 * spelled-out offset costs a dozen or more.
 */
function bestMatchAt(src, at, end, literalLength, reps, head, chain, searchDepth, windowSize, goodEnough, maxMisses) {
  var ll0 = literalLength === 0 ? 1 : 0;
  var max = end - at;

  var repLength = 0;
  var repOffset = 0;

  for (var code = 1; code <= 3; code++) {
    var index = code - 1 + ll0;
    var candidateOffset = index === 3 ? reps[0] - 1 : reps[index];
    if (candidateOffset <= 0 || candidateOffset > at) continue;

    var from = at - candidateOffset;

    // Screen on the first four bytes before scanning: most repeat offsets do
    // not match here, and this runs three times per input position.
    if (max < MIN_MATCH ||
        src[from] !== src[at] ||
        src[from + 1] !== src[at + 1] ||
        src[from + 2] !== src[at + 2]) {
      continue;
    }

    var repLen = commonPrefix(src, from, at, max);
    if (repLen > repLength) {
      repLength = repLen;
      repOffset = candidateOffset;
    }
  }

  // A long repeat is both the cheapest offset and plenty of coverage; there is
  // nothing the hash chain can offer that beats it.
  if (repLength >= goodEnough) {
    foundLength = repLength;
    foundOffset = repOffset;
    return;
  }

  var bestLength = 0;
  var bestOffset = 0;
  var candidate = head[hash4(src, at)];
  var tries = searchDepth;
  var misses = 0;

  while (candidate >= 0 && tries-- > 0) {
    var offset = at - candidate;
    if (offset > windowSize) break;

    // Cheap rejection: the byte past the current best must match.
    if (src[candidate + bestLength] !== src[at + bestLength]) {
      if (++misses >= maxMisses) break;
    } else {
      var length = commonPrefix(src, candidate, at, max);
      if (length > bestLength) {
        bestLength = length;
        bestOffset = offset;
        misses = 0;
        if (bestLength >= goodEnough) break;
      }
    }
    candidate = chain[candidate];
  }

  if (repLength >= MIN_MATCH && repLength + REPEAT_BIAS >= bestLength) {
    foundLength = repLength;
    foundOffset = repOffset;
    return;
  }

  foundLength = bestLength;
  foundOffset = bestOffset;
}

function search(src, start, end, head, chain, searchDepth, windowSize, reps, goodEnough, maxMisses) {
  var sequences = [];
  var literals = bin.alloc(end - start);
  var literalCount = 0;

  var anchor = start;
  var pos = start;
  var limit = end - MIN_MATCH - 1;

  while (pos < limit) {
    bestMatchAt(src, pos, end, pos - anchor, reps, head, chain, searchDepth, windowSize, goodEnough, maxMisses);

    if (foundLength < MIN_MATCH) {
      var h = hash4(src, pos);
      chain[pos] = head[h];
      head[h] = pos;
      pos++;
      continue;
    }

    var length = foundLength;
    var offset = foundOffset;

    // Lazy step: would starting one byte later pay for the extra literal?
    // Not worth asking once the match is already long.
    while (pos + 1 < limit && length < goodEnough) {
      var hh = hash4(src, pos);
      chain[pos] = head[hh];
      head[hh] = pos;

      bestMatchAt(src, pos + 1, end, pos + 1 - anchor, reps, head, chain, searchDepth, windowSize, goodEnough, maxMisses);
      if (foundLength >= length + LAZY_MARGIN) {
        length = foundLength;
        offset = foundOffset;
        pos++;
      } else {
        break;
      }
    }

    var literalLength = pos - anchor;
    bin.copy(src, literals, literalCount, anchor, pos);
    literalCount += literalLength;

    sequences.push({
      literalLength: literalLength,
      offset: offset,
      matchLength: length
    });

    reps = repcodes.resolve(offset, literalLength, reps).reps;

    // Index every position inside the match so later searches can reach them.
    var indexEnd = pos + length < limit ? pos + length : limit;
    for (var i = pos; i < indexEnd; i++) {
      var hi = hash4(src, i);
      chain[i] = head[hi];
      head[hi] = i;
    }

    pos += length;
    anchor = pos;
  }

  // Anything after the final match is trailing literals with no sequence.
  var tail = end - anchor;
  if (tail > 0) {
    bin.copy(src, literals, literalCount, anchor, end);
    literalCount += tail;
  }

  return {
    sequences: sequences,
    literals: literals.subarray(0, literalCount),
    lastLiteralLength: tail
  };
}

exports.findSequences = findSequences;
exports.MatchFinder = MatchFinder;
exports.hash4 = hash4;
