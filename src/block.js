'use strict';

// Block encoding: choose between Raw, RLE and Compressed representations.

var c = require('./constants');
var literalsCodec = require('./literals');
var matchFinder = require('./match');
var huffman = require('./huffman');
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
/**
 * Encode one block.
 *
 * `finder` is optional. When supplied, its index spans the whole input and
 * `start`/`end` locate this block within it, so matches can reach into
 * earlier blocks. Without one, the block is searched on its own.
 */
function encodeBlock(src, reps, options, finder, start, end) {
  var size = src.length;

  if (size > 1 && isRun(src, 0, size)) {
    // Section 3.1.1.5: only Compressed_Blocks contribute to offset history.
    return { type: c.BLOCK_RLE, content: Buffer.from([src[0]]), regeneratedSize: size, reps: reps };
  }

  var compressed = tryCompressed(src, reps, options, finder, start, end);
  if (compressed !== null && compressed.content.length < size) {
    return {
      type: c.BLOCK_COMPRESSED,
      content: compressed.content,
      regeneratedSize: size,
      reps: compressed.reps
    };
  }

  return { type: c.BLOCK_RAW, content: src, regeneratedSize: size, reps: reps };
}

// Build a Compressed_Block: a literals section followed by a sequences
// section. Returns null when the block cannot be represented this way.
function tryCompressed(src, reps, options, finder, start, end) {
  if (src.length < c.MIN_MATCH + 1) return null;

  var found = finder
    ? finder.run(start, end, reps)
    : matchFinder.findSequences(src, options);
  if (found.sequences.length === 0) return null;

  var literalsSection = encodeLiterals(found.literals);

  var encoded = sequenceCodec.encodeSequences(found.sequences, reps);
  if (encoded === null) return null;

  return {
    content: Buffer.concat([literalsSection, encoded.section]),
    reps: encoded.reps
  };
}

// Pick the cheapest representation for the literals: a single repeated byte,
// Huffman coding, or storing them raw.
function encodeLiterals(literals) {
  if (literals.length > 1 && isRun(literals, 0, literals.length)) {
    return literalsCodec.writeRleLiterals(literals[0], literals.length);
  }

  var huff = huffman.compressLiterals(literals);
  if (huff !== null) {
    var content = Buffer.concat([huff.tree, huff.streams]);
    var section = literalsCodec.writeCompressedLiterals(content, literals.length, huff.streamCount);
    // Only worth it if it actually beats storing them.
    if (section !== null && section.length < literals.length + 3) return section;
  }

  return literalsCodec.writeRawLiterals(literals);
}

exports.encodeBlock = encodeBlock;
exports.encodeLiterals = encodeLiterals;
exports.isRun = isRun;
