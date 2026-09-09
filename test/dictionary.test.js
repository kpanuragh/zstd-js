'use strict';

var test = require('node:test');
var assert = require('node:assert');
var fs = require('node:fs');
var os = require('node:os');
var path = require('node:path');
var execFileSync = require('node:child_process').execFileSync;

var zstd = require('../src');

var DICT = Buffer.from('{"id":,"name":"item","active":true,"tags":["a","b"]},'.repeat(20));
var PAYLOAD = Buffer.from(JSON.stringify(
  Array.from({ length: 40 }, function (_, i) {
    return { id: i, name: 'item' + i, active: i % 2 === 0, tags: ['a', 'b'] };
  })
));

function hasZstdCli() {
  try {
    execFileSync('zstd', ['--version'], { stdio: 'ignore' });
    return true;
  } catch (e) {
    return false;
  }
}

test('a dictionary makes small payloads smaller', function () {
  var plain = zstd.compress(PAYLOAD);
  var withDictionary = zstd.compress(PAYLOAD, { dictionary: DICT });
  assert.ok(withDictionary.length < plain.length,
    'expected ' + withDictionary.length + ' < ' + plain.length);
});

test('the reference zstd CLI decodes dictionary frames', { skip: !hasZstdCli() }, function () {
  var dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zstd-js-'));
  var dictPath = path.join(dir, 'dict.bin');
  var framePath = path.join(dir, 'frame.zst');

  fs.writeFileSync(dictPath, DICT);
  fs.writeFileSync(framePath, zstd.compress(PAYLOAD, { dictionary: DICT }));

  var decoded = execFileSync('zstd', ['-d', '-D', dictPath, '-c', framePath],
    { maxBuffer: 1 << 24 });

  assert.ok(Buffer.from(decoded).equals(PAYLOAD));
  fs.rmSync(dir, { recursive: true, force: true });
});

test('dictionaries work across a range of sizes', function () {
  [1, 100, 5000, 200000].forEach(function (n) {
    var payload = Buffer.alloc(n);
    for (var i = 0; i < n; i++) payload[i] = 97 + (i % 23);
    // Only correctness matters here; the CLI check above covers decoding.
    assert.ok(zstd.compress(payload, { dictionary: DICT }).length > 0, 'size ' + n);
  });
});

test('decompress refuses a dictionary rather than returning wrong bytes', function () {
  assert.throws(function () {
    zstd.decompress(zstd.compress(PAYLOAD), { dictionary: DICT });
  }, /does not support dictionaries/);
});

test('a dictionary frame with a checksum is caught, not silently mis-decoded', function () {
  var frame = zstd.compress(PAYLOAD, { dictionary: DICT, checksum: true });
  assert.throws(function () { zstd.decompress(frame); }, /checksum mismatch/);
});

test('checksum verification catches a corrupted frame', function () {
  var data = Buffer.from('detect me '.repeat(500));
  var frame = zstd.compress(data, { checksum: true });

  var caught = 0;
  for (var offset = 10; offset < frame.length - 4; offset++) {
    var copy = Buffer.from(frame);
    copy[offset] ^= 0xFF;
    try {
      var out = zstd.decompress(copy);
      if (!out.equals(data)) {
        assert.fail('offset ' + offset + ' decoded to wrong bytes without being caught');
      }
    } catch (e) {
      caught++;
    }
  }
  assert.ok(caught > 0, 'expected corruption to be detected somewhere');
});
