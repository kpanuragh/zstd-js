'use strict';

var test = require('node:test');
var assert = require('node:assert');
var fs = require('node:fs');
var path = require('node:path');
var vm = require('node:vm');

var readme = fs.readFileSync(path.join(__dirname, '..', 'README.md'), 'utf8');
var zstd = require('../src');

function javascriptBlocks(markdown) {
  var blocks = [];
  var pattern = /```js\n([\s\S]*?)```/g;
  var match;
  while ((match = pattern.exec(markdown)) !== null) blocks.push(match[1]);
  return blocks;
}

// The README's examples drifted from the code once already. Running them is
// the only check that keeps them honest.
test('every JavaScript example in the README runs', function () {
  var blocks = javascriptBlocks(readme);
  assert.ok(blocks.length >= 4, 'expected several examples, found ' + blocks.length);

  var payload = Buffer.from('representative payload '.repeat(200));

  blocks.forEach(function (source, index) {
    var sandbox = {
      // Later examples continue from earlier ones, so the module and the
      // values they refer to are provided rather than redeclared.
      zstd: zstd,
      Compress: zstd.Compress,
      Decompress: zstd.Decompress,
      data: payload,
      payload: payload,
      dict: Buffer.from('representative payload '.repeat(4)),
      frameBytes: zstd.compress(payload),
      firstChunk: payload.subarray(0, 100),
      secondChunk: payload.subarray(100),
      console: { log: function () {} },
      Buffer: Buffer,
      require: function (name) {
        if (name === 'zstd-js') return zstd;
        if (name === 'fs') {
          return { readFileSync: function () { return Buffer.from('sample dictionary bytes'); } };
        }
        return require(name);
      }
    };
    sandbox.frame = sandbox.frameBytes;

    try {
      vm.runInNewContext(source, sandbox, { timeout: 10000 });
    } catch (error) {
      assert.fail('README example ' + (index + 1) + ' failed: ' + error.message +
        '\n---\n' + source + '---');
    }
  });
});

test('the README example round-trips as it claims', function () {
  var frame = zstd.compress('hello world');
  assert.strictEqual(zstd.decompress(frame).toString(), 'hello world');
});

test('documented option defaults match the code', function () {
  var matchSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'match.js'), 'utf8');
  var streamSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'stream.js'), 'utf8');

  assert.ok(/searchDepth \|\| 32/.test(matchSource), 'searchDepth default is documented as 32');
  assert.ok(/windowSize \|\| \(1 << 22\)/.test(matchSource), 'windowSize default is documented as 4 MiB');
  assert.ok(/BLOCK_SIZE_MAX/.test(streamSource), 'streamHistory default is documented as one block');
});
