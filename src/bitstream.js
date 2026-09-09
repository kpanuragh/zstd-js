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
}

BitReader.prototype.readBits = function (nbBits) {
  if (nbBits === 0) return 0;
  if (this.pos - nbBits < -1) throw new Error('bitstream exhausted');

  var value = 0;
  for (var n = 0; n < nbBits; n++) {
    var index = this.pos - nbBits + 1 + n;
    var bit = (this.bytes[index >> 3] >> (index & 7)) & 1;
    value += bit * POW2[n];
  }
  this.pos -= nbBits;
  return value;
};

// Look at the next `nbBits` without consuming them. Bits past the start of
// the stream read as zero, which is what a decoder expects at the end.
BitReader.prototype.peek = function (nbBits) {
  var value = 0;
  for (var n = 0; n < nbBits; n++) {
    var index = this.pos - nbBits + 1 + n;
    var bit = index < 0 ? 0 : (this.bytes[index >> 3] >> (index & 7)) & 1;
    value += bit * POW2[n];
  }
  return value;
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
