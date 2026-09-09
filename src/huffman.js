'use strict';

// Huffman coding for literals (RFC 8878 Section 4.2).
//
// Like FSE bitstreams, Huffman streams are read backward, so symbols are
// emitted from the end of the input toward the start.

var c = require('./constants');
var BitWriter = require('./bitstream').BitWriter;

var MAX_BITS = c.HUF_MAX_BITS; // 11

/** Count occurrences of each byte. */
function countFrequencies(src) {
  var counts = new Uint32Array(256);
  for (var i = 0; i < src.length; i++) counts[src[i]]++;
  return counts;
}

/**
 * Code lengths for a Huffman tree over `counts`, no longer than MAX_BITS.
 *
 * The tree must be complete: zstd deduces the final symbol's weight by
 * completing to the next power of two, so the Kraft sum has to be exactly 1.
 * Length limiting therefore both lengthens and shortens codes to land on it.
 */
function buildCodeLengths(counts) {
  var present = [];
  for (var s = 0; s < 256; s++) {
    if (counts[s] > 0) present.push(s);
  }
  if (present.length === 0) return null;

  var lengths = new Uint8Array(256);

  // A single distinct symbol still needs one bit to be representable.
  if (present.length === 1) {
    lengths[present[0]] = 1;
    return { lengths: lengths, maxBits: 1, present: present };
  }

  // Standard Huffman over a node list. Alphabets are at most 256 symbols, so
  // a linear scan for the two smallest nodes is cheap enough.
  var nodes = present.map(function (sym) {
    return { weight: counts[sym], symbols: [sym], depth: 0 };
  });

  while (nodes.length > 1) {
    var a = -1, b = -1;
    for (var i = 0; i < nodes.length; i++) {
      if (a === -1 || nodes[i].weight < nodes[a].weight) { b = a; a = i; }
      else if (b === -1 || nodes[i].weight < nodes[b].weight) { b = i; }
    }

    var first = nodes[a], second = nodes[b];
    first.symbols.forEach(function (sym) { lengths[sym]++; });
    second.symbols.forEach(function (sym) { lengths[sym]++; });

    var merged = {
      weight: first.weight + second.weight,
      symbols: first.symbols.concat(second.symbols),
      depth: 0
    };
    nodes = nodes.filter(function (_, i) { return i !== a && i !== b; });
    nodes.push(merged);
  }

  limitCodeLengths(lengths, present, MAX_BITS);

  var maxBits = 0;
  present.forEach(function (sym) { if (lengths[sym] > maxBits) maxBits = lengths[sym]; });

  return { lengths: lengths, maxBits: maxBits, present: present };
}

// Clamp to maxBits, then restore Kraft equality by lengthening or shortening.
function limitCodeLengths(lengths, present, maxBits) {
  var target = Math.pow(2, maxBits);

  present.forEach(function (sym) {
    if (lengths[sym] > maxBits) lengths[sym] = maxBits;
  });

  function total() {
    var sum = 0;
    present.forEach(function (sym) { sum += Math.pow(2, maxBits - lengths[sym]); });
    return sum;
  }

  var sum = total();

  // Over budget: lengthen the longest codes still below the cap, which costs
  // the least.
  while (sum > target) {
    var pick = -1;
    present.forEach(function (sym) {
      if (lengths[sym] < maxBits && (pick === -1 || lengths[sym] > lengths[pick])) pick = sym;
    });
    if (pick === -1) break;
    sum -= Math.pow(2, maxBits - lengths[pick] - 1);
    lengths[pick]++;
  }

  // Under budget: shorten codes, longest first, while they still fit.
  var progress = true;
  while (sum < target && progress) {
    progress = false;
    var best = -1;
    present.forEach(function (sym) {
      if (lengths[sym] <= 1) return;
      var gain = Math.pow(2, maxBits - lengths[sym]);
      if (sum + gain > target) return;
      if (best === -1 || lengths[sym] > lengths[best]) best = sym;
    });
    if (best !== -1) {
      sum += Math.pow(2, maxBits - lengths[best]);
      lengths[best]--;
      progress = true;
    }
  }
}

/**
 * Assign canonical codes.
 *
 * Section 4.2.1.3: symbols sort by weight ascending - equivalently by code
 * length descending - keeping natural order within a group, and codes are
 * handed out sequentially starting from the longest.
 */
function assignCodes(lengths, maxBits) {
  var codes = new Uint32Array(256);
  var code = 0;

  for (var bits = maxBits; bits >= 1; bits--) {
    for (var sym = 0; sym < 256; sym++) {
      if (lengths[sym] === bits) codes[sym] = code++;
    }
    code >>= 1;
  }

  return codes;
}

/**
 * Huffman_Tree_Description, direct representation (Section 4.2.1.1).
 *
 * Weights are written as 4-bit fields, two per byte, high nibble first. The
 * final present symbol's weight is implied, so it is not written.
 */
function writeTreeDescription(lengths, maxBits, present) {
  var lastSymbol = present[present.length - 1];

  // Direct representation cannot describe symbols above 127.
  if (lastSymbol > 127) return null;

  var count = lastSymbol; // weights for symbols 0..lastSymbol-1
  var bytes = Buffer.alloc(1 + Math.ceil(count / 2));
  bytes[0] = 127 + count;

  for (var i = 0; i < count; i++) {
    var weight = lengths[i] === 0 ? 0 : maxBits + 1 - lengths[i];
    if (weight > 15) return null;
    var index = 1 + (i >> 1);
    if ((i & 1) === 0) bytes[index] |= weight << 4;
    else bytes[index] |= weight;
  }

  return bytes;
}

/** Encode one stream, writing symbols in reverse so a backward read yields them in order. */
function encodeStream(src, start, end, codes, lengths) {
  var writer = new BitWriter(Math.max(64, (end - start) >> 1));
  for (var i = end - 1; i >= start; i--) {
    var sym = src[i];
    writer.addBits(codes[sym], lengths[sym]);
  }
  return writer.close();
}

/**
 * Huffman-compress a literals buffer.
 * @returns {{tree: Buffer, streams: Buffer, streamCount: number}|null}
 *   null when Huffman would not help or cannot represent this input.
 */
function compressLiterals(literals) {
  if (literals.length < 8) return null;

  var counts = countFrequencies(literals);
  var built = buildCodeLengths(counts);
  if (built === null) return null;

  // A single distinct byte is an RLE literals block, handled by the caller.
  if (built.present.length < 2) return null;

  var tree = writeTreeDescription(built.lengths, built.maxBits, built.present);
  if (tree === null) return null;

  var codes = assignCodes(built.lengths, built.maxBits);

  // Four streams let the decoder work on them in parallel, and are required
  // once the literals exceed what a single-stream header can describe.
  var useFour = literals.length >= 1024;

  if (!useFour) {
    var single = encodeStream(literals, 0, literals.length, codes, built.lengths);
    return { tree: tree, streams: single, streamCount: 1 };
  }

  var segment = (literals.length + 3) >> 2;
  var parts = [];
  for (var i = 0; i < 4; i++) {
    var start = i * segment;
    var end = i === 3 ? literals.length : Math.min(start + segment, literals.length);
    parts.push(encodeStream(literals, start, end, codes, built.lengths));
  }

  // Section 3.1.1.3.1.6: three little-endian sizes; the fourth is inferred.
  var jump = Buffer.alloc(6);
  jump.writeUInt16LE(parts[0].length, 0);
  jump.writeUInt16LE(parts[1].length, 2);
  jump.writeUInt16LE(parts[2].length, 4);

  if (parts[0].length > 65535 || parts[1].length > 65535 || parts[2].length > 65535) return null;

  return {
    tree: tree,
    streams: Buffer.concat([jump, parts[0], parts[1], parts[2], parts[3]]),
    streamCount: 4
  };
}

exports.compressLiterals = compressLiterals;
exports.countFrequencies = countFrequencies;
exports.buildCodeLengths = buildCodeLengths;
exports.assignCodes = assignCodes;
exports.MAX_BITS = MAX_BITS;
