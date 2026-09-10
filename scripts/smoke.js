'use strict';

// Smoke test for Node versions that predate the built-in Zstandard binding.
//
// The main suite compares every frame against Node's own zstd, which only
// exists from 22.15. This checks the package itself works on older runtimes:
// it is pure JavaScript and has no such dependency.

var assert = require('assert');
var zstd = require('..');

var cases = [
  Buffer.alloc(0),
  Buffer.from('hello world'),
  Buffer.from('the quick brown fox jumps over the lazy dog. '.repeat(500)),
  Buffer.alloc(300000, 0x41)
];

var varied = Buffer.alloc(200000);
for (var i = 0; i < varied.length; i++) varied[i] = (i * 31) & 0xFF;
cases.push(varied);

cases.forEach(function (input) {
  [{}, { checksum: true }].forEach(function (options) {
    var frame = zstd.compress(input, options);
    assert.ok(zstd.decompress(frame).equals(input),
      'round-trip failed at ' + input.length + ' bytes, options ' + JSON.stringify(options));
  });
});

// Streaming, both directions.
var payload = Buffer.from('streamed payload '.repeat(5000));
var parts = [];
var stream = new zstd.Compress(function (chunk) { parts.push(chunk); });
for (var at = 0; at < payload.length; at += 1000) {
  stream.push(payload.subarray(at, Math.min(at + 1000, payload.length)));
}
stream.end();
assert.ok(zstd.decompress(Buffer.concat(parts)).equals(payload), 'streaming round-trip failed');

// A dictionary.
var dictionary = Buffer.from('representative sample text ');
var withDictionary = zstd.compress(payload, { dictionary: dictionary });
assert.ok(zstd.decompress(withDictionary, { dictionary: dictionary }).equals(payload),
  'dictionary round-trip failed');

process.stdout.write('smoke: ' + (cases.length * 2 + 2) + ' checks passed on ' + process.version + '\n');
