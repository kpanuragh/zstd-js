'use strict';

var test = require('node:test');
var assert = require('node:assert');
var crypto = require('node:crypto');

var zstd = require('../src');

function skippableFrame(payload) {
  var header = Buffer.alloc(8);
  header.writeUInt32LE(0x184D2A50, 0);
  header.writeUInt32LE(payload.length, 4);
  return Buffer.concat([header, payload]);
}

var A = Buffer.from('first frame content '.repeat(500));
var B = Buffer.from('second frame content '.repeat(300));
var C = Buffer.from('third '.repeat(100));

test('decodes several frames back to back', function () {
  var joined = Buffer.concat([
    zstd.compress(A),
    zstd.compress(B, { checksum: true }),
    zstd.compress(C)
  ]);
  assert.ok(zstd.decompress(joined).equals(Buffer.concat([A, B, C])));
});

test('steps over skippable frames wherever they appear', function () {
  var metadata = skippableFrame(Buffer.from('some user metadata'));

  assert.ok(zstd.decompress(Buffer.concat([metadata, zstd.compress(A)])).equals(A),
    'leading');
  assert.ok(zstd.decompress(Buffer.concat([zstd.compress(A), metadata])).equals(A),
    'trailing');
  assert.ok(zstd.decompress(Buffer.concat([zstd.compress(A), metadata, zstd.compress(B)]))
    .equals(Buffer.concat([A, B])), 'between frames');
  assert.ok(zstd.decompress(Buffer.concat([skippableFrame(Buffer.alloc(0)), zstd.compress(A)]))
    .equals(A), 'empty skippable frame');
});

test('accepts every skippable magic in the reserved range', function () {
  for (var low = 0; low <= 0x0F; low++) {
    var header = Buffer.alloc(8);
    header.writeUInt32LE(0x184D2A50 + low, 0);
    header.writeUInt32LE(4, 4);
    var frame = Buffer.concat([header, Buffer.from('meta'), zstd.compress(C)]);
    assert.ok(zstd.decompress(frame).equals(C), 'magic variant ' + low);
  }
});

test('rejects a skippable frame that runs past the end', function () {
  var header = Buffer.alloc(8);
  header.writeUInt32LE(0x184D2A50, 0);
  header.writeUInt32LE(9999, 4);
  assert.throws(function () { zstd.decompress(header); }, /past the end/);
});

test('a single frame is unaffected', function () {
  var data = crypto.randomBytes(50000);
  assert.ok(zstd.decompress(zstd.compress(data)).equals(data));
});
