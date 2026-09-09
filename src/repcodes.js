'use strict';

// Repeat-offset history (RFC 8878 Section 3.1.1.5).
//
// Offset_Values 1-3 name a recently used offset rather than spelling one out,
// which costs a couple of bits instead of a dozen or more. The match finder
// and the sequence encoder must agree exactly on this state, so both use the
// functions here.

var INITIAL = [1, 4, 8];

/**
 * Offset a given repeat code resolves to, or 0 when it is unusable.
 *
 * With no literals in the sequence the three slots shift by one, and code 3
 * then means "the most recent offset, minus one byte".
 */
function offsetForCode(code, reps, ll0) {
  var index = code - 1 + ll0;
  var value = index === 3 ? reps[0] - 1 : reps[index];
  return value > 0 ? value : 0;
}

/** History after using a repeat code. Code 1 with literals changes nothing. */
function updateForCode(reps, code, ll0) {
  var index = code - 1 + ll0;
  if (index === 0) return reps.slice();

  var current = index === 3 ? reps[0] - 1 : reps[index];
  return [current, reps[0], index >= 2 ? reps[1] : reps[2]];
}

/**
 * Resolve an actual offset into what the bitstream will carry.
 * @returns {{offBase: number, reps: number[]}} offBase is 1-3 for a repeat,
 *   otherwise offset + 3.
 */
function resolve(offset, literalLength, reps) {
  var ll0 = literalLength === 0 ? 1 : 0;

  for (var code = 1; code <= 3; code++) {
    if (offsetForCode(code, reps, ll0) === offset) {
      return { offBase: code, reps: updateForCode(reps, code, ll0) };
    }
  }

  return { offBase: offset + 3, reps: [offset, reps[0], reps[1]] };
}

exports.INITIAL = INITIAL;
exports.resolve = resolve;
exports.offsetForCode = offsetForCode;
exports.updateForCode = updateForCode;
