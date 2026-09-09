'use strict';

var test = require('node:test');
var assert = require('node:assert');
var nodeZlib = require('node:zlib');
var crypto = require('node:crypto');

var zstd = require('../src');
var xxhash = require('../src/xxhash64');

test('matches the published XXH64 vectors', function () {
  assert.strictEqual(xxhash.xxhash64(Buffer.from(''), 0n), 0xEF46DB3751D8E999n);
  assert.strictEqual(xxhash.xxhash64(Buffer.from('a'), 0n), 0xD24EC4F1A98C6E5Bn);
  assert.strictEqual(xxhash.xxhash64(Buffer.from('abc'), 0n), 0x44BC2CF5AD770999n);
});

test('incremental hashing agrees with one-shot', function () {
  var rng = 99;
  function rand() { rng = (Math.imul(rng, 1103515245) + 12345) & 0x7FFFFFFF; return rng / 0x7FFFFFFF; }

  for (var t = 0; t < 200; t++) {
    var data = crypto.randomBytes(Math.floor(rand() * 5000));
    var stream = new xxhash.Xxh64Stream(0n);

    var at = 0;
    while (at < data.length) {
      var take = 1 + Math.floor(rand() * 200);
      stream.update(data.subarray(at, Math.min(at + take, data.length)));
      at += take;
    }
    assert.strictEqual(stream.digest(), xxhash.xxhash64(data, 0n), 'length ' + data.length);
  }
});

test('libzstd accepts and validates our checksums', function () {
  [
    Buffer.alloc(0),
    Buffer.from('a'),
    Buffer.from('hello world'),
    Buffer.alloc(300000, 0x78),
    crypto.randomBytes(50000)
  ].forEach(function (input) {
    var frame = zstd.compress(input, { checksum: true });
    assert.ok(nodeZlib.zstdDecompressSync(frame).equals(input), 'length ' + input.length);
    assert.strictEqual(frame.length, zstd.compress(input, { checksum: false }).length + 4);
  });
});

test('a corrupted frame fails its checksum', function () {
  var frame = zstd.compress(Buffer.from('detect corruption please'), { checksum: true });
  frame[frame.length - 8] ^= 0xFF;
  assert.throws(function () { nodeZlib.zstdDecompressSync(frame); }, /checksum/i);
});

test('checksums are off unless asked for', function () {
  var input = Buffer.from('plain frame');
  assert.strictEqual(zstd.compress(input).length, zstd.compress(input, { checksum: false }).length);
});
