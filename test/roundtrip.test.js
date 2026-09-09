'use strict';

var test = require('node:test');
var assert = require('node:assert');
var nodeZlib = require('node:zlib');
var crypto = require('node:crypto');

var zstd = require('../src');

// Every frame is checked against libzstd, which is what Node's zstd binding
// is. Agreeing with the reference implementation is the only correctness
// standard that matters here.
function assertRoundTrips(input, label) {
  var frame = zstd.compress(input);
  var decoded = nodeZlib.zstdDecompressSync(frame);
  assert.ok(decoded.equals(input), label + ': libzstd decoded ' + decoded.length +
    ' bytes, expected ' + input.length);
}

test('lengths 0 to 80, single repeated byte', function () {
  for (var n = 0; n <= 80; n++) {
    assertRoundTrips(Buffer.alloc(n, 0x61), 'length ' + n);
  }
});

test('lengths 0 to 80, varied bytes', function () {
  for (var n = 0; n <= 80; n++) {
    var buf = Buffer.alloc(n);
    for (var i = 0; i < n; i++) buf[i] = 97 + (i % 26);
    assertRoundTrips(buf, 'length ' + n);
  }
});

test('block boundaries', function () {
  [131071, 131072, 131073, 262143, 262144, 262145].forEach(function (n) {
    assertRoundTrips(Buffer.alloc(n, 0x7A), 'run of ' + n);
    var varied = Buffer.alloc(n);
    for (var i = 0; i < n; i++) varied[i] = (i * 31) & 0xFF;
    assertRoundTrips(varied, 'varied ' + n);
  });
});

test('realistic payloads', function () {
  assertRoundTrips(Buffer.from('the quick brown fox jumps over the lazy dog. '.repeat(500)), 'english');
  assertRoundTrips(Buffer.from(JSON.stringify(
    Array.from({ length: 2000 }, function (_, i) { return { id: i, name: 'item' + i, active: i % 2 === 0 }; })
  )), 'json');
  assertRoundTrips(Buffer.from('function f(x) { return x * 2; }\n'.repeat(2000)), 'source');
});

test('incompressible data falls back without corrupting', function () {
  var random = crypto.randomBytes(200000);
  var frame = zstd.compress(random);
  assertRoundTrips(random, 'random');
  assert.ok(frame.length < random.length + 1024, 'raw fallback should add only framing overhead');
});

test('mixed compressible and incompressible regions', function () {
  var mixed = Buffer.concat([
    Buffer.alloc(50000, 0x41),
    crypto.randomBytes(50000),
    Buffer.from('the end. '.repeat(5000))
  ]);
  assertRoundTrips(mixed, 'mixed');
});

test('randomised payloads over restricted alphabets', function () {
  var rng = 987654321;
  function rand() { rng = (Math.imul(rng, 1103515245) + 12345) & 0x7FFFFFFF; return rng / 0x7FFFFFFF; }

  for (var k = 0; k < 150; k++) {
    var len = 1 + Math.floor(rand() * 20000);
    var alphabet = 1 + Math.floor(rand() * 40);
    var buf = Buffer.alloc(len);
    for (var i = 0; i < len; i++) buf[i] = 97 + Math.floor(rand() * alphabet);
    assertRoundTrips(buf, 'random payload ' + k);
  }
});

test('compressible input actually gets smaller', function () {
  var text = Buffer.from('the quick brown fox jumps over the lazy dog. '.repeat(1000));
  assert.ok(zstd.compress(text).length < text.length / 10);
});
