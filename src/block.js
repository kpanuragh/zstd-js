'use strict';

// Block encoding: choose between Raw, RLE and Compressed representations.

var c = require('./constants');
var literalsCodec = require('./literals');
var matchFinder = require('./match');
var sequenceCodec = require('./sequences');

function isRun(src, start, end) {
  var first = src[start];
  for (var i = start + 1; i < end; i++) {
    if (src[i] !== first) return false;
  }
  return true;
}

/**
 * Encode one block's worth of input.
 * @returns {{type: number, content: Buffer, regeneratedSize: number}}
 */
function encodeBlock(src, options) {
  var size = src.length;

  if (size > 1 && isRun(src, 0, size)) {
    return { type: c.BLOCK_RLE, content: Buffer.from([src[0]]), regeneratedSize: size };
  }

  var compressed = tryCompressed(src, options);
  if (compressed !== null && compressed.length < size) {
    return { type: c.BLOCK_COMPRESSED, content: compressed, regeneratedSize: size };
  }

  return { type: c.BLOCK_RAW, content: src, regeneratedSize: size };
}

// Build a Compressed_Block: a literals section followed by a sequences
// section. Returns null when the block cannot be represented this way.
function tryCompressed(src, options) {
  if (src.length < c.MIN_MATCH + 1) return null;

  var found = matchFinder.findSequences(src, options);
  if (found.sequences.length === 0) return null;

  var literals = found.literals;
  var literalsSection;

  if (literals.length > 1 && isRun(literals, 0, literals.length)) {
    literalsSection = literalsCodec.writeRleLiterals(literals[0], literals.length);
  } else {
    literalsSection = literalsCodec.writeRawLiterals(literals);
  }

  var sequencesSection = sequenceCodec.encodeSequences(found.sequences);
  if (sequencesSection === null) return null;

  return Buffer.concat([literalsSection, sequencesSection]);
}

exports.encodeBlock = encodeBlock;
exports.isRun = isRun;
