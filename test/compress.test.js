'use strict';

var test = require('node:test');
var assert = require('node:assert');
var nodeZlib = require('node:zlib');

var zstd = require('../src');
var constants = require('../src/constants');

// Decoders we check every frame against. Node's is libzstd itself.
function decodesEverywhere(t, frame, expected) {
  assert.ok(nodeZlib.zstdDecompressSync(frame).equals(expected), 'native zstd disagreed');
}

var CASES = [
  ['empty', Buffer.alloc(0)],
  ['single byte', Buffer.from('a')],
  ['short text', Buffer.from('hello hello hello hello')],
  ['255 bytes', Buffer.alloc(255, 0x78)],
  ['256 bytes', Buffer.alloc(256, 0x79)],
  ['crosses the single-segment limit', Buffer.alloc(256 * 1024 + 1, 0x7A)],
  ['spans several blocks', Buffer.alloc(300000, 0x71)],
  ['one megabyte run', Buffer.alloc(1024 * 1024, 0x77)]
];

CASES.forEach(function (entry) {
  test('round-trips: ' + entry[0], function (t) {
    decodesEverywhere(t, zstd.compress(entry[1]), entry[1]);
  });
});

test('round-trips incompressible data', function () {
  var data = Buffer.alloc(200000);
  for (var i = 0; i < data.length; i++) data[i] = (i * 7919) % 256;
  decodesEverywhere(null, zstd.compress(data), data);
});

test('accepts every input type', function () {
  var expected = Buffer.from('abc');
  [
    'abc',
    expected,
    new Uint8Array(expected),
    new DataView(new Uint8Array(expected).buffer),
    new Uint8Array(expected).buffer
  ].forEach(function (input, i) {
    assert.ok(nodeZlib.zstdDecompressSync(zstd.compress(input)).equals(expected), 'input form ' + i);
  });
});

test('rejects input it cannot read', function () {
  assert.throws(function () { zstd.compress(12); }, TypeError);
  assert.throws(function () { zstd.compress(null); }, TypeError);
});

test('emits the zstd magic number', function () {
  var frame = zstd.compress('x');
  assert.strictEqual(frame.readUInt32LE(0), constants.MAGIC);
});

test('collapses runs into RLE blocks', function () {
  // A megabyte of one byte should not cost a megabyte of output.
  assert.ok(zstd.compress(Buffer.alloc(1024 * 1024, 0x41)).length < 64);
});
