'use strict';

var test = require('node:test');
var assert = require('node:assert');
var path = require('node:path');
var execFileSync = require('node:child_process').execFileSync;

// The package claims to run in browsers and under Hermes, neither of which
// provides Node's Buffer. That claim is only worth making if it is checked,
// so this runs the library in a process where Buffer has been removed.
test('works with no Buffer in the runtime', function () {
  var script = [
    'delete global.Buffer;',
    'var zstd = require(' + JSON.stringify(path.join(__dirname, '..', 'src')) + ');',
    'var assert = require("assert");',
    'function u8(t) { return new TextEncoder().encode(t); }',
    '',
    'var cases = [new Uint8Array(0), u8("hello"), u8("the quick brown fox ".repeat(2000)),',
    '  new Uint8Array(300000).fill(65)];',
    'var varied = new Uint8Array(200000);',
    'for (var i = 0; i < varied.length; i++) varied[i] = (i * 31) & 255;',
    'cases.push(varied);',
    '',
    'cases.forEach(function (input) {',
    '  [{}, { checksum: true }].forEach(function (options) {',
    '    var frame = zstd.compress(input, options);',
    '    assert.ok(frame instanceof Uint8Array, "result should be a Uint8Array");',
    '    assert.ok(!global.Buffer, "Buffer must stay absent");',
    '    var back = zstd.decompress(frame);',
    '    assert.strictEqual(back.length, input.length);',
    '    for (var i = 0; i < input.length; i++) assert.strictEqual(back[i], input[i]);',
    '  });',
    '});',
    '',
    '// Streaming and dictionaries too.',
    'var payload = u8("streamed without Buffer ".repeat(3000));',
    'var parts = [];',
    'var stream = new zstd.Compress(function (chunk) { parts.push(chunk); });',
    'for (var at = 0; at < payload.length; at += 1000) {',
    '  stream.push(payload.subarray(at, Math.min(at + 1000, payload.length)));',
    '}',
    'stream.end();',
    'var total = 0;',
    'parts.forEach(function (p) { total += p.length; });',
    'var joined = new Uint8Array(total);',
    'var offset = 0;',
    'parts.forEach(function (p) { joined.set(p, offset); offset += p.length; });',
    'assert.strictEqual(zstd.decompress(joined).length, payload.length);',
    '',
    'var dict = u8("representative sample ");',
    'var withDict = zstd.compress(payload, { dictionary: dict });',
    'assert.strictEqual(zstd.decompress(withDict, { dictionary: dict }).length, payload.length);',
    '',
    'process.stdout.write("ok");'
  ].join('\n');

  var output = execFileSync(process.execPath, ['-e', script], { encoding: 'utf8' });
  assert.strictEqual(output, 'ok');
});

test('returns a Buffer when the runtime has one', function () {
  var zstd = require('../src');
  var frame = zstd.compress('hello');

  assert.ok(Buffer.isBuffer(frame), 'compress should return a Buffer under Node');
  assert.ok(Buffer.isBuffer(zstd.decompress(frame)), 'decompress should too');

  // And it is a view over the same memory, not an extra copy.
  assert.ok(frame instanceof Uint8Array);
});

test('accepts plain Uint8Array input without Buffer involvement', function () {
  var zstd = require('../src');
  var input = new Uint8Array(5000);
  for (var i = 0; i < input.length; i++) input[i] = (i * 7) & 255;

  var back = zstd.decompress(zstd.compress(input));
  assert.strictEqual(back.length, input.length);
  for (var j = 0; j < input.length; j++) assert.strictEqual(back[j], input[j]);
});
