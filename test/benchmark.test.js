'use strict';

var test = require('node:test');
var assert = require('node:assert');
var fs = require('node:fs');
var path = require('node:path');

var benchmark = require('../scripts/benchmark');
var zstd = require('../src');

// The README's compression table went stale once already, quietly, because
// nothing recomputed it. Numbers in documentation are claims like any other.
test('the README compression table matches what the code produces', function () {
  var readme = fs.readFileSync(path.join(__dirname, '..', 'README.md'), 'utf8');

  // Only this package's own column is checked. The zstd and gzip columns come
  // from whatever libraries the measuring runtime was built against, and
  // differ between Node releases, so asserting them would fail on a runtime
  // other than the one the table was generated on.
  benchmark.CORPUS.forEach(function (entry) {
    var name = entry[0];
    var expected = zstd.compress(entry[1]).length.toLocaleString('en-US');

    var row = readme.split('\n').find(function (line) {
      return line.indexOf('| ' + name + ' |') === 0;
    });
    assert.ok(row, 'README has no row for ' + name);

    var ours = row.split('|')[3].trim().replace(/\*/g, '');
    assert.strictEqual(ours, expected,
      name + ': README says ' + ours + ', code produces ' + expected +
      '. Run `node scripts/benchmark.js` and paste the table in.');
  });
});

test('the benchmark corpus is deterministic', function () {
  var first = benchmark.CORPUS.map(function (entry) { return entry[1].length; });

  delete require.cache[require.resolve('../scripts/benchmark')];
  var reloaded = require('../scripts/benchmark');
  var second = reloaded.CORPUS.map(function (entry) { return entry[1].length; });

  assert.deepStrictEqual(second, first, 'corpus sizes must not vary between runs');
});
