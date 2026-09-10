'use strict';

var bin = require('./bytes');

// Streaming compression.
//
// Input arrives in pieces and blocks are emitted as soon as enough has
// accumulated, so neither the whole input nor the whole output needs to be
// held in memory. The frame header omits Frame_Content_Size, since the total
// is not known when the header is written.

var c = require('./constants');
var frame = require('./frame');
var block = require('./block');
var matchFinder = require('./match');
var repcodes = require('./repcodes');
var xxhash = require('./xxhash64');
var decode = require('./decode');

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

  // Bytes already emitted that a later block may still match against. Kept to
  // one block's worth: enough to link neighbouring blocks without making each
  // block re-index an unbounded history.
  this.historyLimit = this.options.streamHistory === undefined
    ? c.BLOCK_SIZE_MAX
    : this.options.streamHistory;
  this.history = bin.alloc(0);
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
    this.onData(bin.external(frame.writeFrameHeader(null, { checksum: this.checksum })), false);
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
  return this.push(bin.alloc(0), true);
};

Compress.prototype._take = function (size) {
  var joined = bin.concat(this.pending, this.pendingLength);
  var head = joined.subarray(0, size);
  var tail = joined.subarray(size);

  this.pending = tail.length > 0 ? [tail] : [];
  this.pendingLength = tail.length;
  return head;
};

Compress.prototype._emit = function (data, last) {
  var encoded;

  if (this.history.length > 0 && data.length > 0) {
    // Index the retained history ahead of this block so matches can reach
    // back into what has already been emitted.
    var combined = bin.concat([this.history, data]);
    var finder = new matchFinder.MatchFinder(combined, this.options);
    finder.prime(this.history.length);
    encoded = block.encodeBlock(data, this.reps, this.options,
      finder, this.history.length, combined.length);
  } else {
    encoded = block.encodeBlock(data, this.reps, this.options);
  }

  this.reps = encoded.reps;

  if (this.historyLimit > 0 && data.length > 0) {
    var carried = bin.concat([this.history, data]);
    this.history = carried.length > this.historyLimit
      ? carried.subarray(carried.length - this.historyLimit)
      : carried;
  }

  var declared = encoded.type === c.BLOCK_RLE ? encoded.regeneratedSize : encoded.content.length;
  var header = frame.writeBlockHeader(declared, encoded.type, last);

  if (!last) {
    this.onData(bin.external(bin.concat([header, encoded.content])), false);
    return;
  }

  var parts = [header, encoded.content];
  if (this.hasher) {
    var trailer = bin.alloc(4);
    bin.writeU32(trailer, Number(this.hasher.digest() & 0xFFFFFFFFn), 0);
    parts.push(trailer);
  }
  this.onData(bin.external(bin.concat(parts)), true);
};

function toBytes(input) {
  if (input === undefined || input === null) return bin.alloc(0);
  if (typeof input === 'string') return bin.from(input);
  if (input instanceof Uint8Array) return input;
  if (ArrayBuffer.isView(input) || input instanceof ArrayBuffer) return bin.from(input);
  throw new TypeError('input must be a string, Buffer, TypedArray, DataView or ArrayBuffer');
}

/**
 * Streaming decompression, mirroring {@link Compress}.
 *
 * Blocks are decoded as their bytes arrive rather than waiting for the whole
 * frame.
 */
function Decompress(onData, options) {
  if (typeof onData !== 'function') {
    throw new TypeError('Decompress requires a callback: new Decompress((chunk, final) => ...)');
  }
  options = options || {};
  this.inner = new decode.StreamingDecoder(function (chunk, final) {
    onData(bin.external(chunk), final);
  }, {
    dictionary: options.dictionary ? toBytes(options.dictionary) : undefined
  });
}

Decompress.prototype.push = function (chunk, final) {
  this.inner.push(toBytes(chunk), !!final);
  return this;
};

Decompress.prototype.end = function () {
  return this.push(bin.alloc(0), true);
};

exports.Compress = Compress;
exports.Decompress = Decompress;
