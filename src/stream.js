'use strict';

// Streaming compression.
//
// Input arrives in pieces and blocks are emitted as soon as enough has
// accumulated, so neither the whole input nor the whole output needs to be
// held in memory. The frame header omits Frame_Content_Size, since the total
// is not known when the header is written.

var fzstd = require('fzstd');

var c = require('./constants');
var frame = require('./frame');
var block = require('./block');
var repcodes = require('./repcodes');
var xxhash = require('./xxhash64');

/**
 * @param {(chunk: Buffer, final: boolean) => void} onData receives each piece
 *   of the frame as it is produced; `final` is true on the last call.
 * @param {{searchDepth?: number, windowSize?: number, checksum?: boolean}} [options]
 */
function Compress(onData, options) {
  if (typeof onData !== 'function') {
    throw new TypeError('Compress requires a callback: new Compress((chunk, final) => ...)');
  }

  this.onData = onData;
  this.options = options || {};
  this.checksum = this.options.checksum === true;

  this.pending = [];
  this.pendingLength = 0;
  this.reps = repcodes.INITIAL.slice();
  this.hasher = this.checksum ? new xxhash.Xxh64Stream(0n) : null;
  this.started = false;
  this.finished = false;
}

/**
 * Add input. Pass `final` on the last call to close the frame.
 */
Compress.prototype.push = function (chunk, final) {
  if (this.finished) throw new Error('push after the stream was finished');

  chunk = toBytes(chunk);

  if (!this.started) {
    this.started = true;
    // Content size is unknown mid-stream, so the header carries a window
    // descriptor instead of Frame_Content_Size.
    this.onData(frame.writeFrameHeader(null, { checksum: this.checksum }), false);
  }

  if (chunk.length > 0) {
    if (this.hasher) this.hasher.update(chunk);
    this.pending.push(chunk);
    this.pendingLength += chunk.length;
  }

  // Emit only while a full block is guaranteed not to be the last one, so
  // the final block can carry the Last_Block flag.
  while (this.pendingLength > c.BLOCK_SIZE_MAX) {
    this._emit(this._take(c.BLOCK_SIZE_MAX), false);
  }

  if (final) {
    this._emit(this._take(this.pendingLength), true);
    this.finished = true;
  }

  return this;
};

/** Finish the frame without adding more input. */
Compress.prototype.end = function () {
  return this.push(Buffer.alloc(0), true);
};

Compress.prototype._take = function (size) {
  var joined = Buffer.concat(this.pending, this.pendingLength);
  var head = joined.subarray(0, size);
  var tail = joined.subarray(size);

  this.pending = tail.length > 0 ? [tail] : [];
  this.pendingLength = tail.length;
  return head;
};

Compress.prototype._emit = function (data, last) {
  var encoded = block.encodeBlock(data, this.reps, this.options);
  this.reps = encoded.reps;

  var declared = encoded.type === c.BLOCK_RLE ? encoded.regeneratedSize : encoded.content.length;
  var header = frame.writeBlockHeader(declared, encoded.type, last);

  if (!last) {
    this.onData(Buffer.concat([header, encoded.content]), false);
    return;
  }

  var parts = [header, encoded.content];
  if (this.hasher) {
    var trailer = Buffer.alloc(4);
    trailer.writeUInt32LE(Number(this.hasher.digest() & 0xFFFFFFFFn), 0);
    parts.push(trailer);
  }
  this.onData(Buffer.concat(parts), true);
};

function toBytes(input) {
  if (input === undefined || input === null) return Buffer.alloc(0);
  if (typeof input === 'string') return Buffer.from(input, 'utf8');
  if (Buffer.isBuffer(input)) return input;
  if (ArrayBuffer.isView(input)) return Buffer.from(input.buffer, input.byteOffset, input.byteLength);
  if (input instanceof ArrayBuffer) return Buffer.from(input);
  throw new TypeError('input must be a string, Buffer, TypedArray, DataView or ArrayBuffer');
}

/**
 * Streaming decompression, wrapping fzstd's incremental decoder so both
 * directions have the same shape.
 */
function Decompress(onData) {
  if (typeof onData !== 'function') {
    throw new TypeError('Decompress requires a callback: new Decompress((chunk, final) => ...)');
  }
  this.inner = new fzstd.Decompress(function (data, final) {
    onData(Buffer.from(data.buffer, data.byteOffset, data.byteLength), final);
  });
}

Decompress.prototype.push = function (chunk, final) {
  var bytes = toBytes(chunk);
  this.inner.push(new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength), !!final);
  return this;
};

Decompress.prototype.end = function () {
  return this.push(Buffer.alloc(0), true);
};

exports.Compress = Compress;
exports.Decompress = Decompress;
