'use strict';

var bin = require('./bytes');

// Dictionary parsing (RFC 8878 Section 5).
//
// Two kinds exist. A formal dictionary starts with a magic number and carries
// entropy tables and starting repeat offsets ahead of its content. Anything
// else is a raw-content dictionary: the bytes are simply treated as data
// preceding the frame.

var c = require('./constants');
var fseDecode = require('./fse-decode');
var huffmanDecode = require('./huffman-decode');
var repcodes = require('./repcodes');

var MAGIC = 0xEC30A437;

/**
 * @param {Buffer} bytes
 * @returns {{id: number, content: Buffer, reps: number[], huffman: object|null,
 *            tables: {ll: object|null, of: object|null, ml: object|null}}}
 */
function parse(bytes) {
  if (bytes.length < 8 || bin.readU32(bytes, 0) !== MAGIC) {
    return rawDictionary(bytes);
  }

  var id = bin.readU32(bytes, 4);
  var at = 8;

  // Order is fixed: literals Huffman table, then offsets, match lengths and
  // literal lengths, then the three starting repeat offsets.
  var tree = huffmanDecode.readTreeDescription(bytes, at);
  var huffman = huffmanDecode.buildDecodeTable(tree.nbBits, tree.maxBits);
  at += tree.size;

  var of = readTable(bytes, at, c.OF_SYMBOL_MAX, c.OF_FSE_ACCURACY_MAX);
  at += of.size;
  var ml = readTable(bytes, at, c.ML_SYMBOL_MAX, c.ML_FSE_ACCURACY_MAX);
  at += ml.size;
  var ll = readTable(bytes, at, c.LL_SYMBOL_MAX, c.LL_FSE_ACCURACY_MAX);
  at += ll.size;

  if (bytes.length - at < 12) throw new Error('dictionary ends before its repeat offsets');

  var reps = [
    bin.readU32(bytes, at),
    bin.readU32(bytes, at + 4),
    bin.readU32(bytes, at + 8)
  ];
  at += 12;

  var content = bytes.subarray(at);

  reps.forEach(function (offset) {
    if (offset <= 0 || offset > content.length) {
      throw new Error('dictionary repeat offset lies outside its content');
    }
  });

  return {
    id: id,
    content: content,
    reps: reps,
    huffman: huffman,
    tables: { ll: ll.table, of: of.table, ml: ml.table }
  };
}

function readTable(bytes, at, maxSymbol, maxAccuracy) {
  var description = fseDecode.readTableDescription(bytes, at, maxSymbol, maxAccuracy);
  return {
    table: fseDecode.buildDTable(description.normalized, description.accuracyLog, description.maxSymbol),
    size: description.size
  };
}

function rawDictionary(bytes) {
  return {
    id: 0,
    content: bytes,
    reps: repcodes.INITIAL.slice(),
    huffman: null,
    tables: { ll: null, of: null, ml: null }
  };
}

exports.MAGIC = MAGIC;
exports.parse = parse;
exports.isFormal = function (bytes) {
  return bytes.length >= 8 && bin.readU32(bytes, 0) === MAGIC;
};
