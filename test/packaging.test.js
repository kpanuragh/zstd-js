'use strict';

var test = require('node:test');
var assert = require('node:assert');
var fs = require('node:fs');
var path = require('node:path');

var pkg = require('../package.json');

var root = path.join(__dirname, '..');
var readme = fs.readFileSync(path.join(root, 'README.md'), 'utf8');

// The README shipped to npm went stale for three releases because a version
// number was written into it by hand. It should not name one at all.
test('the README does not hardcode a version', function () {
  var matches = readme.match(/\b\d+\.\d+\.\d+\b/g) || [];
  var versionLike = matches.filter(function (m) {
    // Numbers inside the results table are sizes, not versions.
    return !/^\d{1,3}\.\d{3}\.\d{3}$/.test(m);
  });
  assert.deepStrictEqual(versionLike, [],
    'README names ' + versionLike.join(', ') + '; keep versions in package.json only');
});

test('every file package.json promises is present', function () {
  pkg.files.forEach(function (entry) {
    var target = path.join(root, entry.replace(/\/$/, ''));
    assert.ok(fs.existsSync(target), entry + ' is listed in files but missing');
  });
  assert.ok(fs.existsSync(path.join(root, pkg.types)), pkg.types + ' is missing');
  assert.ok(fs.existsSync(path.join(root, pkg.main)), pkg.main + ' is missing');
});

test('the package declares no dependencies', function () {
  assert.deepStrictEqual(pkg.dependencies || {}, {},
    'this package is meant to have none');
});

test('nothing in src requires a dependency', function () {
  fs.readdirSync(path.join(root, 'src')).forEach(function (name) {
    var source = fs.readFileSync(path.join(root, 'src', name), 'utf8');
    var requires = source.match(/require\('([^']+)'\)/g) || [];
    requires.forEach(function (line) {
      var target = line.slice(9, -2);
      assert.ok(target.startsWith('.') || ['buffer', 'stream', 'util', 'assert'].indexOf(target) !== -1,
        name + ' requires ' + target);
    });
  });
});
