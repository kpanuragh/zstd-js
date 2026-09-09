'use strict';

// XXH64, the hash Zstandard uses for the optional Content_Checksum
// (RFC 8878 Section 3.1.1.1.4). The frame stores the low 32 bits.
//
// The algorithm is defined over 64-bit wrapping arithmetic, which JavaScript's
// bitwise operators cannot express, so this uses BigInt masked to 64 bits.
// It runs once per frame, so the cost is acceptable next to the match finder.

var MASK = (1n << 64n) - 1n;

var P1 = 11400714785074694791n;
var P2 = 14029467366897019727n;
var P3 = 1609587929392839161n;
var P4 = 9650029242287828579n;
var P5 = 2870177450012600261n;

function rotl(value, bits) {
  return ((value << BigInt(bits)) | (value >> BigInt(64 - bits))) & MASK;
}

function round(acc, input) {
  acc = (acc + input * P2) & MASK;
  acc = rotl(acc, 31);
  return (acc * P1) & MASK;
}

function mergeRound(acc, value) {
  var merged = round(0n, value);
  acc = acc ^ merged;
  return ((acc * P1) + P4) & MASK;
}

function read64(bytes, at) {
  var low = BigInt(bytes.readUInt32LE(at));
  var high = BigInt(bytes.readUInt32LE(at + 4));
  return (high << 32n) | low;
}

/**
 * @param {Buffer} input
 * @param {bigint} [seed]
 * @returns {bigint} the full 64-bit hash
 */
function xxhash64(input, seed) {
  seed = seed === undefined ? 0n : BigInt(seed) & MASK;

  var length = input.length;
  var position = 0;
  var hash;

  if (length >= 32) {
    var limit = length - 32;
    var v1 = (seed + P1 + P2) & MASK;
    var v2 = (seed + P2) & MASK;
    var v3 = seed;
    var v4 = (seed - P1) & MASK;

    do {
      v1 = round(v1, read64(input, position)); position += 8;
      v2 = round(v2, read64(input, position)); position += 8;
      v3 = round(v3, read64(input, position)); position += 8;
      v4 = round(v4, read64(input, position)); position += 8;
    } while (position <= limit);

    hash = (rotl(v1, 1) + rotl(v2, 7) + rotl(v3, 12) + rotl(v4, 18)) & MASK;
    hash = mergeRound(hash, v1);
    hash = mergeRound(hash, v2);
    hash = mergeRound(hash, v3);
    hash = mergeRound(hash, v4);
  } else {
    hash = (seed + P5) & MASK;
  }

  hash = (hash + BigInt(length)) & MASK;

  while (position + 8 <= length) {
    var k1 = round(0n, read64(input, position));
    hash = hash ^ k1;
    hash = ((rotl(hash, 27) * P1) + P4) & MASK;
    position += 8;
  }

  if (position + 4 <= length) {
    hash = hash ^ ((BigInt(input.readUInt32LE(position)) * P1) & MASK);
    hash = ((rotl(hash, 23) * P2) + P3) & MASK;
    position += 4;
  }

  while (position < length) {
    hash = hash ^ ((BigInt(input[position]) * P5) & MASK);
    hash = (rotl(hash, 11) * P1) & MASK;
    position++;
  }

  hash = hash ^ (hash >> 33n);
  hash = (hash * P2) & MASK;
  hash = hash ^ (hash >> 29n);
  hash = (hash * P3) & MASK;
  hash = hash ^ (hash >> 32n);

  return hash;
}

/** Low 32 bits, which is what a frame's Content_Checksum carries. */
function checksum32(input) {
  return Number(xxhash64(input, 0n) & 0xFFFFFFFFn);
}

/**
 * Incremental XXH64, for hashing content that arrives in pieces.
 *
 * The core loop consumes 32 bytes at a time, so anything short of a full
 * stripe is held back until the next update or the final digest.
 */
function Xxh64Stream(seed) {
  seed = seed === undefined ? 0n : BigInt(seed) & MASK;
  this.seed = seed;
  this.v1 = (seed + P1 + P2) & MASK;
  this.v2 = (seed + P2) & MASK;
  this.v3 = seed;
  this.v4 = (seed - P1) & MASK;
  this.total = 0;
  this.buffer = Buffer.alloc(32);
  this.buffered = 0;
}

Xxh64Stream.prototype.update = function (chunk) {
  this.total += chunk.length;
  var position = 0;

  if (this.buffered > 0) {
    var wanted = 32 - this.buffered;
    if (chunk.length < wanted) {
      chunk.copy(this.buffer, this.buffered);
      this.buffered += chunk.length;
      return this;
    }
    chunk.copy(this.buffer, this.buffered, 0, wanted);
    this._stripe(this.buffer, 0);
    this.buffered = 0;
    position = wanted;
  }

  while (position + 32 <= chunk.length) {
    this._stripe(chunk, position);
    position += 32;
  }

  var rest = chunk.length - position;
  if (rest > 0) {
    chunk.copy(this.buffer, 0, position, chunk.length);
    this.buffered = rest;
  }
  return this;
};

Xxh64Stream.prototype._stripe = function (bytes, at) {
  this.v1 = round(this.v1, read64(bytes, at));
  this.v2 = round(this.v2, read64(bytes, at + 8));
  this.v3 = round(this.v3, read64(bytes, at + 16));
  this.v4 = round(this.v4, read64(bytes, at + 24));
};

Xxh64Stream.prototype.digest = function () {
  var hash;

  if (this.total >= 32) {
    hash = (rotl(this.v1, 1) + rotl(this.v2, 7) + rotl(this.v3, 12) + rotl(this.v4, 18)) & MASK;
    hash = mergeRound(hash, this.v1);
    hash = mergeRound(hash, this.v2);
    hash = mergeRound(hash, this.v3);
    hash = mergeRound(hash, this.v4);
  } else {
    hash = (this.seed + P5) & MASK;
  }

  hash = (hash + BigInt(this.total)) & MASK;

  var tail = this.buffer.subarray(0, this.buffered);
  var position = 0;

  while (position + 8 <= tail.length) {
    hash = hash ^ round(0n, read64(tail, position));
    hash = ((rotl(hash, 27) * P1) + P4) & MASK;
    position += 8;
  }

  if (position + 4 <= tail.length) {
    hash = hash ^ ((BigInt(tail.readUInt32LE(position)) * P1) & MASK);
    hash = ((rotl(hash, 23) * P2) + P3) & MASK;
    position += 4;
  }

  while (position < tail.length) {
    hash = hash ^ ((BigInt(tail[position]) * P5) & MASK);
    hash = (rotl(hash, 11) * P1) & MASK;
    position++;
  }

  hash = hash ^ (hash >> 33n);
  hash = (hash * P2) & MASK;
  hash = hash ^ (hash >> 29n);
  hash = (hash * P3) & MASK;
  hash = hash ^ (hash >> 32n);

  return hash;
}

exports.xxhash64 = xxhash64;
exports.checksum32 = checksum32;
exports.Xxh64Stream = Xxh64Stream;
