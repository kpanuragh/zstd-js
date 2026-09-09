'use strict';

// Zstandard bitstreams (RFC 8878 Section 4.1).
//
// The compressor writes bits forward; the decompressor reads them backward.
// After the final information bit the compressor writes a single 1 bit and
// pads the rest of the byte with zeros, so the last byte is never zero and
// the decoder can locate the end marker by finding its highest set bit.
//
// Because the decoder consumes bits in reverse, anything written here must be
// written in reverse of the order it will be read. For the sequences bitstream
// that means emitting the last sequence first.
//
// The accumulator is a plain number rather than a 32-bit integer: JavaScript's
// bitwise operators are 32-bit, and a single field can be 32 bits wide on top
// of up to 7 pending bits. Multiplication and division by powers of two stay
// exact well below 2^53.

var POW2 = new Float64Array(64);
for (var i = 0; i < 64; i++) POW2[i] = Math.pow(2, i);

// Masks for the fast extraction path, which handles up to 25 bits so that a
// 32-bit word always covers the field plus its bit offset.
var MASKS = new Int32Array(26);
for (var m = 0; m <= 25; m++) MASKS[m] = m === 0 ? 0 : ((1 << m) - 1);

function BitWriter(capacity) {
  this.buf = Buffer.alloc(capacity || 1024);
  this.len = 0;
  this.container = 0;
  this.bits = 0;
}

BitWriter.prototype._grow = function (needed) {
  if (this.len + needed <= this.buf.length) return;
  var size = this.buf.length * 2;
  while (size < this.len + needed) size *= 2;
  var next = Buffer.alloc(size);
  this.buf.copy(next, 0, 0, this.len);
  this.buf = next;
};

BitWriter.prototype._push = function (byte) {
  this._grow(1);
  this.buf[this.len++] = byte;
};

// Append nbBits low bits of value. Bits already written stay below these.
BitWriter.prototype.addBits = function (value, nbBits) {
  if (nbBits === 0) return;

  var masked = nbBits >= 53 ? value : value % POW2[nbBits];
  this.container += masked * POW2[this.bits];
  this.bits += nbBits;

  while (this.bits >= 8) {
    this._push(this.container % 256);
    this.container = Math.floor(this.container / 256);
    this.bits -= 8;
  }
};

// Write the end marker and pad to a byte boundary. Returns the finished bytes.
BitWriter.prototype.close = function () {
  this.addBits(1, 1);
  if (this.bits > 0) {
    this._push(this.container % 256);
    this.container = 0;
    this.bits = 0;
  }
  return this.buf.subarray(0, this.len);
};

// Reads a stream produced by BitWriter, in the order a zstd decoder would:
// starting at the last byte, below the end marker, working backward.
function BitReader(bytes) {
  if (bytes.length === 0) throw new Error('empty bitstream');

  var last = bytes[bytes.length - 1];
  if (last === 0) throw new Error('last byte of a bitstream must not be zero');

  // Bit index of the end marker, counted from the start of the stream. The
  // data ends immediately below it.
  var highest = 31 - Math.clz32(last);
  this.bytes = bytes;
  this.pos = (bytes.length - 1) * 8 + highest - 1;
  // Highest byte index where a 4-byte read stays inside the buffer.
  this.fastLimit = bytes.length - 4;
}

// Bits are extracted by reading a little-endian word straddling the wanted
// range and shifting, rather than one bit at a time. Reads near the start of
// the stream fall back to a padded path, since the fast one would run off the
// front of the buffer.
BitReader.prototype.peek = function (nbBits) {
  if (nbBits === 0) return 0;

  var low = this.pos - nbBits + 1;
  var byteIndex = low >> 3;

  if (low >= 0 && nbBits <= 25 && byteIndex <= this.fastLimit) {
    var bytes = this.bytes;
    var word = bytes[byteIndex] |
      (bytes[byteIndex + 1] << 8) |
      (bytes[byteIndex + 2] << 16) |
      (bytes[byteIndex + 3] << 24);
    return (word >>> (low & 7)) & MASKS[nbBits];
  }

  return this._peekSlow(nbBits, low);
};

// Handles wide fields and the ends of the stream, where bits below the start
// read as zero.
BitReader.prototype._peekSlow = function (nbBits, low) {
  var value = 0;
  var bytes = this.bytes;
  var length = bytes.length;

  for (var n = 0; n < nbBits; n++) {
    var index = low + n;
    if (index < 0) continue;

    var byteIndex = index >> 3;
    if (byteIndex >= length) continue;

    if ((bytes[byteIndex] >> (index & 7)) & 1) value += POW2[n];
  }
  return value;
};

BitReader.prototype.readBits = function (nbBits) {
  if (nbBits === 0) return 0;

  var pos = this.pos;
  if (pos - nbBits < -1) throw new Error('bitstream exhausted');

  var low = pos - nbBits + 1;
  var byteIndex = low >> 3;

  if (low >= 0 && nbBits <= 25 && byteIndex <= this.fastLimit) {
    var bytes = this.bytes;
    var word = bytes[byteIndex] |
      (bytes[byteIndex + 1] << 8) |
      (bytes[byteIndex + 2] << 16) |
      (bytes[byteIndex + 3] << 24);
    this.pos = pos - nbBits;
    return (word >>> (low & 7)) & MASKS[nbBits];
  }

  // Wider than a word can cover: take the more significant half first.
  if (nbBits > 25) {
    var high = this.readBits(nbBits - 16);
    return high * 65536 + this.readBits(16);
  }

  this.pos = pos - nbBits;
  return this._peekSlow(nbBits, low);
};

BitReader.prototype.skip = function (nbBits) {
  this.pos -= nbBits;
};

BitReader.prototype.exhausted = function () {
  return this.pos < 0;
};

/** Bits still unread. Goes negative once the stream is overrun. */
BitReader.prototype.remaining = function () {
  return this.pos + 1;
};

exports.BitWriter = BitWriter;
exports.BitReader = BitReader;
