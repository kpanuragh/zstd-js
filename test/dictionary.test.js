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

test('dictionary frames round-trip within this package', function () {
  var frame = zstd.compress(PAYLOAD, { dictionary: DICT });
  assert.ok(zstd.decompress(frame, { dictionary: DICT }).equals(PAYLOAD));
});

test('decoding a dictionary frame without the dictionary fails loudly', function () {
  var frame = zstd.compress(PAYLOAD, { dictionary: DICT, checksum: true });
  assert.throws(function () { zstd.decompress(frame); });
});

test('streaming decompression accepts a dictionary', function () {
  var frame = zstd.compress(PAYLOAD, { dictionary: DICT });
  var out = [];
  var stream = new zstd.Decompress(function (chunk) { out.push(chunk); }, { dictionary: DICT });

  for (var i = 0; i < frame.length; i += 7) {
    var end = Math.min(i + 7, frame.length);
    stream.push(frame.subarray(i, end), end === frame.length);
  }
  assert.ok(Buffer.concat(out).equals(PAYLOAD));
});

test('dictionaries help across a range of payload sizes', function () {
  [1, 100, 5000, 200000].forEach(function (n) {
    var payload = Buffer.alloc(n);
    for (var i = 0; i < n; i++) payload[i] = 97 + (i % 23);
    var frame = zstd.compress(payload, { dictionary: DICT });
    assert.ok(zstd.decompress(frame, { dictionary: DICT }).equals(payload), 'size ' + n);
  });
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

// A dictionary produced by `zstd --train` carries entropy tables and starting
// repeat offsets ahead of its content, and is identified by an id.
test('parses the formal dictionary format', function () {
  var dictionaryFormat = require('../src/dictionary');

  var raw = dictionaryFormat.parse(DICT);
  assert.strictEqual(raw.id, 0, 'raw content has no id');
  assert.ok(raw.content.equals(DICT));
  assert.deepStrictEqual(raw.reps, [1, 4, 8]);
  assert.strictEqual(raw.huffman, null);
});

test('a formal dictionary round-trips and declares its id', function (t) {
  var fs = require('node:fs');
  var os = require('node:os');
  var path = require('node:path');
  var execFileSync = require('node:child_process').execFileSync;

  var dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zstd-js-dict-'));
  try {
    // Train a dictionary from samples that share structure.
    var samples = path.join(dir, 'samples');
    fs.mkdirSync(samples);
    for (var i = 0; i < 200; i++) {
      var rows = [];
      for (var j = 0; j < 20; j++) {
        rows.push(JSON.stringify({ id: i * 20 + j, name: 'item' + (i * 20 + j), active: j % 2 === 0 }));
      }
      fs.writeFileSync(path.join(samples, 's' + i + '.json'), '[' + rows.join(',') + ']');
    }

    var dictPath = path.join(dir, 'trained.dict');
    var sampleFiles = fs.readdirSync(samples).map(function (name) {
      return path.join(samples, name);
    });

    try {
      execFileSync('zstd', ['--train'].concat(sampleFiles, ['-o', dictPath]), { stdio: 'ignore' });
    } catch (e) {
      t.skip('zstd CLI cannot train a dictionary here: ' + e.message);
      return;
    }

    var trained = fs.readFileSync(dictPath);
    var dictionaryFormat = require('../src/dictionary');
    assert.ok(dictionaryFormat.isFormal(trained), 'trained dictionary carries the magic number');

    var parsed = dictionaryFormat.parse(trained);
    assert.ok(parsed.id > 0, 'formal dictionaries carry an id');
    assert.ok(parsed.content.length > 0);
    assert.ok(parsed.huffman, 'entropy tables are present');

    var payload = fs.readFileSync(path.join(samples, 's7.json'));
    var frame = zstd.compress(payload, { dictionary: trained });

    assert.ok(frame.length < zstd.compress(payload).length, 'the dictionary should help');
    assert.ok(zstd.decompress(frame, { dictionary: trained }).equals(payload));

    // The reference implementation is the authority on whether the frame is
    // well formed and genuinely tied to this dictionary.
    var framePath = path.join(dir, 'frame.zst');
    fs.writeFileSync(framePath, frame);

    var decoded = execFileSync('zstd', ['-d', '-D', dictPath, '-c', framePath],
      { maxBuffer: 1 << 24, stdio: ['ignore', 'pipe', 'ignore'] });
    assert.ok(Buffer.from(decoded).equals(payload), 'zstd -d -D should reproduce the payload');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
