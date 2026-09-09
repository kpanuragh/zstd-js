'use strict';

var test = require('node:test');
var assert = require('node:assert');
var nodeZlib = require('node:zlib');
var crypto = require('node:crypto');

var zstd = require('../src');

test('decompresses what it compressed', function () {
  [
    Buffer.alloc(0),
    Buffer.from('hello'),
    Buffer.from('the quick brown fox '.repeat(1000)),
    Buffer.alloc(300000, 0x78),
    crypto.randomBytes(50000)
  ].forEach(function (input) {
    assert.ok(zstd.decompress(zstd.compress(input)).equals(input),
      'failed at length ' + input.length);
  });
});

test('decompresses frames produced by libzstd', function () {
  [
    Buffer.from('hello from node'),
    Buffer.from(JSON.stringify(Array.from({ length: 1000 }, function (_, i) { return { i: i }; }))),
    crypto.randomBytes(20000)
  ].forEach(function (input) {
    var frame = nodeZlib.zstdCompressSync(input);
    assert.ok(zstd.decompress(frame).equals(input));
  });
});

test('accepts every input type', function () {
  var frame = zstd.compress('round trip');
  [
    frame,
    new Uint8Array(frame),
    new DataView(new Uint8Array(frame).buffer),
    new Uint8Array(frame).buffer
  ].forEach(function (form, i) {
    assert.strictEqual(zstd.decompress(form).toString(), 'round trip', 'input form ' + i);
  });
});

test('rejects data that is not a Zstandard frame', function () {
  assert.throws(function () { zstd.decompress(Buffer.from([1, 2, 3, 4, 5])); });
  assert.throws(function () { zstd.decompress(Buffer.from('not a frame at all')); });
});

test('rejects input it cannot read', function () {
  assert.throws(function () { zstd.decompress(12); }, TypeError);
  assert.throws(function () { zstd.decompress(null); }, TypeError);
});
