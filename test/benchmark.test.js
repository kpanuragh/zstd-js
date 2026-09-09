'use strict';

var test = require('node:test');
var assert = require('node:assert');
var fs = require('node:fs');
var path = require('node:path');

var benchmark = require('../scripts/benchmark');

// The README's compression table went stale once already, quietly, because
// nothing recomputed it. Numbers in documentation are claims like any other.
test('the README compression table matches what the code produces', function () {
  var readme = fs.readFileSync(path.join(__dirname, '..', 'README.md'), 'utf8');
  var expected = benchmark.table();

  expected.split('\n').forEach(function (row) {
    assert.ok(readme.indexOf(row) !== -1,
      'README is missing or disagrees with this row:\n  ' + row +
      '\nRun `node scripts/benchmark.js` and paste the table in.');
  });
});

test('the benchmark corpus is deterministic', function () {
  var first = benchmark.CORPUS.map(function (entry) { return entry[1].length; });

  delete require.cache[require.resolve('../scripts/benchmark')];
  var reloaded = require('../scripts/benchmark');
  var second = reloaded.CORPUS.map(function (entry) { return entry[1].length; });

  assert.deepStrictEqual(second, first, 'corpus sizes must not vary between runs');
});
