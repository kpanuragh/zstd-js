'use strict';

// Regenerates the benchmark tables in README.md.
//
// The corpus is generated rather than read from disk so the numbers are
// reproducible: a file in the repository would change and quietly invalidate
// the table.

var zlib = require('zlib');
var crypto = require('crypto');
var zstd = require('../src');

function repeated(text, times) {
  return Buffer.from(text.repeat(times));
}

function json(records) {
  var rows = [];
  for (var i = 0; i < records; i++) {
    rows.push({ id: i, name: 'item' + i, active: i % 2 === 0 });
  }
  return Buffer.from(JSON.stringify(rows));
}

function csv(rows) {
  var lines = [];
  for (var i = 0; i < rows; i++) {
    lines.push(i + ',name' + i + ',2024-01-' + ((i % 28) + 1) + ',active,' + (i * 7));
  }
  return Buffer.from(lines.join('\n'));
}

function prose(words) {
  // Deterministic English-like text with a realistic vocabulary spread.
  var vocabulary = ('the of and to in a is that it for as with was on be by not this from at which have '
    + 'or an they one all their has more been its when there each such about would these other into').split(' ');
  var out = [];
  var seed = 1;
  for (var i = 0; i < words; i++) {
    seed = (Math.imul(seed, 1103515245) + 12345) & 0x7FFFFFFF;
    out.push(vocabulary[seed % vocabulary.length]);
    if (i % 12 === 11) out.push('.\n');
  }
  return Buffer.from(out.join(' '));
}

exports.CORPUS = [
  ['English text', repeated('the quick brown fox jumps over the lazy dog. ', 20000)],
  ['HTML', repeated('<div class="row"><span>value</span></div>\n', 20000)],
  ['Prose', prose(120000)],
  ['CSV', csv(5000)],
  ['JSON', json(20000)],
  ['Incompressible', crypto.createHash('shake256', { outputLength: 900000 }).update('seed').digest()]
];

function table() {
  var lines = [];
  lines.push('| Input | Original | zstd-js | zstd | gzip | vs zstd |');
  lines.push('|---|---|---|---|---|---|');

  exports.CORPUS.forEach(function (entry) {
    var name = entry[0];
    var data = entry[1];
    var ours = zstd.compress(data).length;
    var theirs = zlib.zstdCompressSync(data).length;
    var gz = zlib.gzipSync(data).length;

    lines.push('| ' + name + ' | ' + data.length.toLocaleString('en-US') + ' | ' +
      ours.toLocaleString('en-US') + ' | ' + theirs.toLocaleString('en-US') + ' | ' +
      gz.toLocaleString('en-US') + ' | ' + (ours / theirs).toFixed(2) + 'x |');
  });

  return lines.join('\n');
}

exports.table = table;

if (require.main === module) {
  process.stdout.write(table() + '\n');
}
