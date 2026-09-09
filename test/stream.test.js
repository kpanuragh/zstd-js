'use strict';

var test = require('node:test');
var assert = require('node:assert');
var nodeZlib = require('node:zlib');
var crypto = require('node:crypto');

var zstd = require('../src');

function compressStreamed(data, chunkSize, options) {
  var parts = [];
  var finals = 0;
  var stream = new zstd.Compress(function (chunk, final) {
    parts.push(chunk);
    if (final) finals++;
  }, options);

  for (var i = 0; i < data.length; i += chunkSize) {
    stream.push(data.subarray(i, Math.min(i + chunkSize, data.length)));
  }
  stream.end();

  assert.strictEqual(finals, 1, 'exactly one final callback');
  return Buffer.concat(parts);
}

test('streamed output matches one-shot content at any chunk size', function () {
  var data = Buffer.from('the quick brown fox jumps over the lazy dog. '.repeat(5000));

  [1, 17, 1024, 65536, 300000].forEach(function (size) {
    var frame = compressStreamed(data, size, {});
    assert.ok(nodeZlib.zstdDecompressSync(frame).equals(data), 'chunk size ' + size);
  });
});

test('streams empty input', function () {
  var frame = compressStreamed(Buffer.alloc(0), 1024, {});
  assert.strictEqual(nodeZlib.zstdDecompressSync(frame).length, 0);
});

test('streams data spanning several blocks', function () {
  var data = crypto.randomBytes(400000);
  assert.ok(nodeZlib.zstdDecompressSync(compressStreamed(data, 7777, {})).equals(data));
});

test('streaming honours the checksum option', function () {
  var data = Buffer.from('checksummed streaming payload '.repeat(2000));
  var withCk = compressStreamed(data, 4096, { checksum: true });
  var without = compressStreamed(data, 4096, { checksum: false });

  assert.ok(nodeZlib.zstdDecompressSync(withCk).equals(data));
  assert.strictEqual(withCk.length, without.length + 4);
});

test('end() alone produces a valid empty frame', function () {
  var parts = [];
  new zstd.Compress(function (c) { parts.push(c); }).end();
  assert.strictEqual(nodeZlib.zstdDecompressSync(Buffer.concat(parts)).length, 0);
});

test('pushing after finishing is refused', function () {
  var stream = new zstd.Compress(function () {});
  stream.end();
  assert.throws(function () { stream.push(Buffer.from('more')); }, /finished/);
});

test('Compress requires a callback', function () {
  assert.throws(function () { new zstd.Compress(); }, TypeError);
});

test('streaming decompression reassembles a frame fed in fragments', function () {
  var data = Buffer.from('fragmented decode '.repeat(9000));
  var frame = zstd.compress(data);

  var out = [];
  var stream = new zstd.Decompress(function (chunk) { out.push(chunk); });
  for (var i = 0; i < frame.length; i += 13) {
    var end = Math.min(i + 13, frame.length);
    stream.push(frame.subarray(i, end), end === frame.length);
  }
  assert.ok(Buffer.concat(out).equals(data));
});
