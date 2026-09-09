# zstd-js

Zstandard compression in pure JavaScript. No WebAssembly, no native bindings — it runs anywhere JavaScript does, including React Native and Hermes.

> A complete Zstandard codec with **no dependencies**. Compression does LZ77 matching, Huffman-coded literals, FSE-coded sequences with custom tables, and repeat offsets. Decompression reads frames from any encoder, including features this one never emits. Both directions stream, and both support dictionaries. Every frame is verified against libzstd.

## Install

```bash
npm install zstd-js
```

## Usage

```js
const zstd = require('zstd-js');

const frame = zstd.compress('hello world');
const back = zstd.decompress(frame);   // <Buffer 68 65 6c 6c 6f ...>
```

`compress` accepts a string, `Buffer`, `TypedArray`, `DataView` or
`ArrayBuffer`, and returns a `Buffer` holding a standard `.zst` frame. Any
Zstandard decoder reads it — the `zstd` CLI, Node's built-in
`zlib.zstdDecompressSync`, `fzstd`, or this package's own `decompress`.

```js
// Options
zstd.compress(data, {
  checksum: true,       // append the XXH64 content checksum (4 bytes)
  searchDepth: 64,      // match finder effort, default 32
  windowSize: 1 << 20   // farthest a match may reach back, default 4 MiB
});
```

### Dictionaries

A dictionary is any buffer of representative data. Matches may reach into it,
which helps a lot on small payloads that share structure:

```js
const dict = Buffer.from(fs.readFileSync('samples.bin'));
const frame = zstd.compress(payload, { dictionary: dict });
```

```js
const back = zstd.decompress(frame, { dictionary: dict });
```

The frame can only be read by a decoder holding the same dictionary — this
package, libzstd, or `zstd -d -D samples.bin`. Decoding without it fails
rather than returning wrong bytes.

### Streaming

Neither the whole input nor the whole output has to be in memory:

```js
const { Compress, Decompress } = require('zstd-js');

const parts = [];
const stream = new Compress((chunk, final) => parts.push(chunk));
stream.push(firstChunk);
stream.push(secondChunk);
stream.end();

const out = [];
const decoder = new Decompress((chunk, final) => out.push(chunk));
decoder.push(frameBytes, true);
```

TypeScript definitions ship with the package.

## Why

Every Zstandard implementation for JavaScript is either a native binding or a WebAssembly build. That leaves two gaps:

- **React Native.** Hermes has no WebAssembly, so none of the WASM packages run there.
- **Synchronous APIs.** WASM modules need asynchronous initialisation, which cannot back a `compressSync`.

Decoding was already solved in pure JS by [`fzstd`](https://github.com/101arrowz/fzstd). Encoding was not — there is no other pure-JavaScript Zstandard compressor on npm. That is what this package adds.

Decoding started out delegated to `fzstd`, but dictionary support needed a decoder that could be seeded with dictionary content, so it is now implemented here. The package has no dependencies.

## Current behaviour

```js
const zstd = require('zstd-js');

const frame = zstd.compress('hello world');
// -> a valid .zst frame, readable by any Zstandard decoder
```

### Compression

Measured against Node's native Zstandard (libzstd) and gzip:

| Input | Original | zstd-js | zstd | gzip | vs zstd |
|---|---|---|---|---|---|
| English text | 900,000 | **139** | 140 | 2,698 | 0.99x |
| HTML | 840,000 | 133 | 133 | 2,520 | 1.00x |
| Source code | 19,545 | **5,680** | 5,872 | 5,481 | 0.97x |
| RFC plain text | 112,425 | 28,243 | 27,002 | 25,804 | 1.05x |
| JSON | 907,781 | 51,491 | 27,310 | 102,228 | 1.89x |
| Incompressible | 900,000 | 900,031 | 900,030 | 900,293 | 1.00x |

Compression runs at roughly 15-22 MB/s on ordinary data, and around 110 MB/s
on data it recognises as incompressible, which it detects and passes through
rather than searching.

### Decompression

Against [`fzstd`](https://github.com/101arrowz/fzstd), the other pure-JS
Zstandard decoder, decoding frames produced by libzstd:

| Input | zstd-js | fzstd | ratio |
|---|---|---|---|
| English text | **1,479 MB/s** | 754 MB/s | 1.96x |
| HTML | **1,476 MB/s** | 761 MB/s | 1.94x |
| Incompressible | **3,590 MB/s** | 2,297 MB/s | 1.56x |
| RFC plain text | **101 MB/s** | 85 MB/s | 1.19x |
| JSON | 305 MB/s | 335 MB/s | 0.91x |
| Source code | 124 MB/s | 141 MB/s | 0.88x |

Faster on four of six, and substantially so where matches dominate. The two
it trails are literal-heavy, where the Huffman loop does most of the work.

JSON is the weakest compression case and the main thing left to improve: zstd
finds shorter, better-priced sequences there than this parser does.

## Roadmap

- [x] Frame header: single-segment and explicit `Window_Descriptor` paths
- [x] Block framing: `Raw_Block` and `RLE_Block`
- [x] Bitstream writer and reader, with zstd's backward-read convention
- [x] Verified code tables and predefined FSE distributions
- [x] LZ77 match finder, hash chains with configurable search depth
- [x] FSE encoder, predefined tables
- [x] `Compressed_Block` assembly, with fallback to raw when it would not help
- [x] Huffman literal coding, with the four-stream layout
- [x] FSE encoder, custom tables with normalisation and table transmission
- [x] Repeat offsets
- [x] Lazy matching
- [x] xxhash64 content checksum, one-shot and incremental
- [x] Streaming API for both directions
- [x] Dictionary support, both directions
- [x] Cross-block matching, one-shot and streaming
- [x] Decoder, replacing the last dependency
- [ ] Multi-frame and skippable-frame decoding
- [ ] Formal dictionary format

## Design notes

Everything is written against [RFC 8878](https://www.rfc-editor.org/rfc/rfc8878.txt), and the code tables carry self-checks: the predefined distributions must sum to `2^accuracy_log`, and the literal-length and match-length baselines must be contiguous under their extra-bit widths. Those checks caught a transcription error during development.

The bitstream is the part most likely to be subtly wrong, so it is fuzzed: 5,000 randomised field sequences are written and read back per test run.

## Testing

```bash
npm test
```

Every frame produced is round-tripped through Node's native Zstandard, which is
libzstd itself, so correctness is measured against the reference implementation
rather than against this package's own decoder. The suite covers every input
length from 0 to 200, the 128 KB block boundaries, text, JSON, CSV, source,
incompressible and mixed content, and randomised payloads over restricted
alphabets.

## Limitations

- JSON-like input compresses about 1.8x worse than real zstd. The match finder
  already finds the longest matches available — raising `searchDepth` changes
  nothing — so the remaining gap is in how sequences are priced, not in
  parsing.
- Only the first frame of a multi-frame stream is decoded, and skippable
  frames are not handled.
- Dictionaries are raw content only; the formal dictionary format with its
  own entropy tables is not read.

## License

MIT
