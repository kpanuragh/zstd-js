'use strict';

var test = require('node:test');
var assert = require('node:assert');
var nodeZlib = require('node:zlib');
var crypto = require('node:crypto');

var zstd = require('../src');

// The decoder has to read frames from any encoder, not just this one.
// libzstd uses features this package never emits: FSE-compressed Huffman
// weights, treeless literals and repeat-mode tables.
test('decodes libzstd frames at every compression level', function () {
  var payloads = [
    Buffer.from('the quick brown fox jumps over the lazy dog. '.repeat(500)),
    Buffer.from(JSON.stringify(Array.from({ length: 2000 }, function (_, i) {
      return { id: i, name: 'item' + i, active: i % 2 === 0 };
    }))),
    crypto.randomBytes(100000)
  ];

  [1, 3, 6, 9, 12, 15, 19].forEach(function (level) {
    payloads.forEach(function (payload, index) {
      var frame = nodeZlib.zstdCompressSync(payload, {
        params: { [nodeZlib.constants.ZSTD_c_compressionLevel]: level }
      });
      assert.ok(zstd.decompress(frame).equals(payload),
        'level ' + level + ', payload ' + index);
    });
  });
});

test('decodes libzstd frames of every small length', function () {
  for (var n = 0; n <= 200; n++) {
    var run = Buffer.alloc(n, 0x61);
    assert.ok(zstd.decompress(nodeZlib.zstdCompressSync(run)).equals(run), 'run ' + n);

    var varied = Buffer.alloc(n);
    for (var i = 0; i < n; i++) varied[i] = 97 + (i % 26);
    assert.ok(zstd.decompress(nodeZlib.zstdCompressSync(varied)).equals(varied), 'varied ' + n);
  }
});

test('decodes frames spanning several blocks', function () {
  [131072, 262145, 500000].forEach(function (n) {
    var data = Buffer.alloc(n, 0x5a);
    assert.ok(zstd.decompress(nodeZlib.zstdCompressSync(data)).equals(data), 'size ' + n);
  });
});

test('verifies the content checksum', function () {
  var data = Buffer.from('checksummed '.repeat(2000));
  var frame = zstd.compress(data, { checksum: true });
  assert.ok(zstd.decompress(frame).equals(data));

  var corrupted = Buffer.from(frame);
  corrupted[corrupted.length - 6] ^= 0xFF;
  assert.throws(function () { zstd.decompress(corrupted); });
});

test('rejects malformed input', function () {
  assert.throws(function () { zstd.decompress(Buffer.from([1, 2, 3, 4, 5])); }, /not a Zstandard frame/);
  assert.throws(function () { zstd.decompress(Buffer.alloc(0)); });
  assert.throws(function () { zstd.decompress(Buffer.from('nowhere near a frame')); });
});

test('streaming decode matches one-shot at any chunk size', function () {
  var data = Buffer.from('streamed decode '.repeat(9000));

  [1, 13, 4096, 999999].forEach(function (size) {
    [zstd.compress(data, { checksum: true }), nodeZlib.zstdCompressSync(data)].forEach(function (frame, which) {
      var out = [];
      var finals = 0;
      var stream = new zstd.Decompress(function (chunk, final) {
        out.push(chunk);
        if (final) finals++;
      });

      for (var i = 0; i < frame.length; i += size) {
        var end = Math.min(i + size, frame.length);
        stream.push(frame.subarray(i, end), end === frame.length);
      }

      assert.strictEqual(finals, 1, 'one final callback');
      assert.ok(Buffer.concat(out).equals(data), 'chunk ' + size + ', source ' + which);
    });
  });
});

test('streaming decode rejects a truncated frame', function () {
  var frame = zstd.compress(Buffer.from('truncate me '.repeat(500)));
  var stream = new zstd.Decompress(function () {});
  assert.throws(function () {
    stream.push(frame.subarray(0, frame.length - 5), true);
  }, /before the frame was complete/);
});
