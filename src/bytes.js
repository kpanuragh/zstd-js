'use strict';

// Byte-array primitives over Uint8Array.
//
// Node's Buffer is not available in browsers or under Hermes without a
// polyfill, and this package is meant to run there. Everything internal
// therefore works on plain Uint8Array; only the public entry points hand back
// a Buffer, and only when the runtime has one, so Node callers see no change.

var hasBuffer = typeof Buffer !== 'undefined' && typeof Buffer.from === 'function';

function alloc(size) {
  return new Uint8Array(size);
}

/** Bytes from a string (UTF-8), array-like, or existing view. */
function from(value) {
  if (typeof value === 'string') return fromString(value);
  if (value instanceof Uint8Array) return value;
  if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  return new Uint8Array(value);
}

function fromString(text) {
  if (typeof TextEncoder !== 'undefined') return new TextEncoder().encode(text);

  // Node before TextEncoder was global, and any runtime without it.
  if (hasBuffer) {
    var buf = Buffer.from(text, 'utf8');
    return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
  }
  throw new Error('no way to encode a string: neither TextEncoder nor Buffer is available');
}

function concat(parts, totalLength) {
  if (totalLength === undefined) {
    totalLength = 0;
    for (var n = 0; n < parts.length; n++) totalLength += parts[n].length;
  }

  var out = new Uint8Array(totalLength);
  var at = 0;
  for (var i = 0; i < parts.length; i++) {
    out.set(parts[i], at);
    at += parts[i].length;
  }
  return out;
}

/**
 * Buffer.prototype.copy, as a free function.
 *
 * This runs in the hottest loops in both directions, so the naive
 * `target.set(source.subarray(...))` is avoided: it allocates a view on every
 * call, where Buffer.copy did a plain memmove. Same-array copies go through
 * copyWithin, which is native and handles overlap; short ranges are cheaper
 * to move by hand than to build a view for.
 */
function copy(source, target, targetStart, sourceStart, sourceEnd) {
  targetStart = targetStart || 0;
  sourceStart = sourceStart || 0;
  if (sourceEnd === undefined) sourceEnd = source.length;

  var length = sourceEnd - sourceStart;
  if (length <= 0) return 0;

  if (source === target) {
    target.copyWithin(targetStart, sourceStart, sourceEnd);
    return length;
  }

  if (length < 32) {
    for (var i = 0; i < length; i++) target[targetStart + i] = source[sourceStart + i];
    return length;
  }

  target.set(sourceStart === 0 && sourceEnd === source.length
    ? source
    : source.subarray(sourceStart, sourceEnd), targetStart);
  return length;
}

/**
 * An independent copy of a range. Distinct from `from`, which hands back a
 * view when given one - callers that keep the result past the next write to
 * the source need their own memory.
 */
function slice(source, start, end) {
  return source.slice(start, end);
}

function fill(target, value, start, end) {
  target.fill(value, start, end);
  return target;
}

function readU16(bytes, at) {
  return bytes[at] | (bytes[at + 1] << 8);
}

function writeU16(bytes, value, at) {
  bytes[at] = value & 0xFF;
  bytes[at + 1] = (value >>> 8) & 0xFF;
}

function readU24(bytes, at) {
  return bytes[at] | (bytes[at + 1] << 8) | (bytes[at + 2] << 16);
}

function writeU24(bytes, value, at) {
  bytes[at] = value & 0xFF;
  bytes[at + 1] = (value >>> 8) & 0xFF;
  bytes[at + 2] = (value >>> 16) & 0xFF;
}

function readU32(bytes, at) {
  // Unsigned: the shift below would otherwise make the top bit negative.
  return (bytes[at] | (bytes[at + 1] << 8) | (bytes[at + 2] << 16) | (bytes[at + 3] << 24)) >>> 0;
}

function writeU32(bytes, value, at) {
  bytes[at] = value & 0xFF;
  bytes[at + 1] = (value >>> 8) & 0xFF;
  bytes[at + 2] = (value >>> 16) & 0xFF;
  bytes[at + 3] = (value >>> 24) & 0xFF;
}

// 64-bit values only appear as a frame's content size, which is a count of
// bytes, so ordinary numbers carry it without loss well past any real input.
function readU64(bytes, at) {
  return readU32(bytes, at) + readU32(bytes, at + 4) * 4294967296;
}

function writeU64(bytes, value, at) {
  writeU32(bytes, value % 4294967296, at);
  writeU32(bytes, Math.floor(value / 4294967296), at + 4);
}

/**
 * What the public API returns: a Buffer where one exists, so Node callers can
 * still call toString() and equals() on results, and a Uint8Array elsewhere.
 * Either way it is a view over the same memory, not a copy.
 */
function external(bytes) {
  if (!hasBuffer) return bytes;
  return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

exports.hasBuffer = hasBuffer;
exports.alloc = alloc;
exports.from = from;
exports.concat = concat;
exports.copy = copy;
exports.fill = fill;
exports.slice = slice;
exports.readU16 = readU16;
exports.writeU16 = writeU16;
exports.readU24 = readU24;
exports.writeU24 = writeU24;
exports.readU32 = readU32;
exports.writeU32 = writeU32;
exports.readU64 = readU64;
exports.writeU64 = writeU64;
exports.external = external;
