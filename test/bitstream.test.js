'use strict';

var test = require('node:test');
var assert = require('node:assert');

var { BitWriter, BitReader } = require('../src/bitstream');

// A zstd decoder reads a bitstream backward, so fields come back in reverse.
function roundTrip(fields) {
  var w = new BitWriter(8);
  fields.forEach(function (f) { w.addBits(f[0], f[1]); });
  var bytes = w.close();

  var r = new BitReader(bytes);
  var got = [];
  for (var i = fields.length - 1; i >= 0; i--) got.push([r.readBits(fields[i][1]), fields[i][1]]);
  return { got: got.reverse(), bytes: bytes };
}

test('bits read back in reverse order, exactly', function () {
  [
    [[1, 1]],
    [[0, 1]],
    [[5, 3], [9, 4]],
    [[255, 8], [0, 8], [170, 8]],
    [[0x7FFFFFFF, 31]],
    [[0xFFFFFFFF, 32]]
  ].forEach(function (fields) {
    assert.deepStrictEqual(roundTrip(fields).got, fields);
  });
});

test('the last byte is never zero, so the end marker is findable', function () {
  for (var n = 1; n <= 32; n++) {
    var bytes = roundTrip([[0, n]]).bytes;
    assert.notStrictEqual(bytes[bytes.length - 1], 0, 'all-zero payload of ' + n + ' bits');
  }
});

test('randomised round-trips', function () {
  var rng = 12345;
  function rand() { rng = (rng * 1103515245 + 12345) & 0x7FFFFFFF; return rng / 0x7FFFFFFF; }

  for (var t = 0; t < 5000; t++) {
    var fields = [];
    var count = 1 + Math.floor(rand() * 12);
    for (var i = 0; i < count; i++) {
      var n = 1 + Math.floor(rand() * 32);
      fields.push([Math.floor(rand() * Math.pow(2, n)), n]);
    }
    assert.deepStrictEqual(roundTrip(fields).got, fields);
  }
});

test('a zero last byte is rejected as malformed', function () {
  assert.throws(function () { new BitReader(Buffer.from([0x01, 0x00])); }, /must not be zero/);
  assert.throws(function () { new BitReader(Buffer.alloc(0)); }, /empty/);
});
