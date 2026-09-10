'use strict';

var bin = require('./bytes');

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
    return { type: c.BLOCK_RLE, content: bin.from([src[0]]), regeneratedSize: size, reps: reps };
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
/**
 * Cheap test for data that cannot be compressed at all.
 *
 * Searching a block of random bytes costs as much as searching a compressible
 * one and is then thrown away. Two quick passes catch that case: near-flat
 * byte frequencies mean Huffman coding cannot help, and almost no repeated
 * four-byte prefixes mean the match finder will not either. Both have to hold,
 * because random-looking bytes can still repeat at a distance.
 */
function looksIncompressible(src, finder, start) {
  if (src.length < 4096) return false;

  var counts = new Uint32Array(256);
  for (var i = 0; i < src.length; i++) counts[src[i]]++;

  var entropy = 0;
  var total = src.length;
  for (var b = 0; b < 256; b++) {
    if (counts[b] === 0) continue;
    var p = counts[b] / total;
    entropy -= p * Math.log2(p);
  }
  if (entropy < 7.5) return false;

  // Sample four-byte prefixes and see how often one recurs, both within this
  // block and against whatever the match index already holds - earlier blocks
  // and any dictionary. Missing the second would discard real matches, as it
  // does for random bytes that happen to repeat a block or more later.
  var SAMPLE_BITS = 13;
  var seen = new Int32Array(1 << SAMPLE_BITS).fill(-1);
  var samples = 0;
  var repeats = 0;

  var head = finder ? finder.head : null;
  var chain = finder ? finder.chain : null;
  var source = finder ? finder.src : null;

  for (var at = 0; at + 4 <= src.length; at += 16) {
    var v = (src[at] | (src[at + 1] << 8) | (src[at + 2] << 16) | (src[at + 3] << 24)) >>> 0;
    var slot = (Math.imul(v, 2654435761) >>> (32 - SAMPLE_BITS));
    samples++;

    if (seen[slot] === v) {
      repeats++;
    } else if (head !== null) {
      // Does anything already indexed start with these four bytes? The hash
      // is only 16 bits, so the true match is usually not at the head of the
      // chain once a lot has been indexed; walk a few links before giving up.
      var candidate = head[matchFinder.hash4(src, at)];
      var steps = 8;
      while (candidate >= 0 && steps-- > 0) {
        if (candidate + 4 <= source.length &&
            source[candidate] === src[at] &&
            source[candidate + 1] === src[at + 1] &&
            source[candidate + 2] === src[at + 2] &&
            source[candidate + 3] === src[at + 3]) {
          repeats++;
          break;
        }
        candidate = chain[candidate];
      }
    }

    seen[slot] = v;
  }

  return samples > 64 && repeats / samples < 0.02;
}

function tryCompressed(src, reps, options, finder, start, end) {
  if (src.length < c.MIN_MATCH + 1) return null;
  if (looksIncompressible(src, finder, start)) {
    // Still index it, so a later block that repeats this one can match it.
    if (finder) finder.index(start, end);
    return null;
  }

  var found = finder
    ? finder.run(start, end, reps)
    : matchFinder.findSequences(src, options);
  if (found.sequences.length === 0) return null;

  var literalsSection = encodeLiterals(found.literals);

  var encoded = sequenceCodec.encodeSequences(found.sequences, reps);
  if (encoded === null) return null;

  return {
    content: bin.concat([literalsSection, encoded.section]),
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
    var content = bin.concat([huff.tree, huff.streams]);
    var section = literalsCodec.writeCompressedLiterals(content, literals.length, huff.streamCount);
    // Only worth it if it actually beats storing them.
    if (section !== null && section.length < literals.length + 3) return section;
  }

  return literalsCodec.writeRawLiterals(literals);
}

exports.encodeBlock = encodeBlock;
exports.encodeLiterals = encodeLiterals;
exports.isRun = isRun;
exports.looksIncompressible = looksIncompressible;
