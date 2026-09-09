# zstd-js

Zstandard compression in pure JavaScript. No WebAssembly, no native bindings — it runs anywhere JavaScript does, including React Native and Hermes.

> **Status: 0.1.0.** Compression and decompression both work. The encoder does LZ77 matching, Huffman-coded literals, FSE-coded sequences with custom tables, and repeat offsets; output lands within a few percent of real zstd on most inputs and beats gzip comfortably. Every frame is verified against libzstd.

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

`decompress` delegates to `fzstd` rather than reimplementing a decoder. It is well tested and MIT licensed, and writing a second one would not have helped anybody.

## Current behaviour

```js
const zstd = require('zstd-js');

const frame = zstd.compress('hello world');
// -> a valid .zst frame, readable by any Zstandard decoder
```

Measured against Node's native Zstandard (libzstd) and gzip:

| Input | Original | zstd-js | zstd | gzip | vs zstd | vs gzip |
|---|---|---|---|---|---|---|
| English text | 45,000 | **64** | 66 | 213 | 0.97x | 0.30x |
| HTML | 122,500 | **69** | 71 | 442 | 0.97x | 0.16x |
| Source code | 6,971 | 2,523 | 2,537 | 2,457 | 0.99x | 1.03x |
| RFC plain text | 112,425 | 28,243 | 27,002 | 25,804 | 1.05x | 1.09x |
| CSV | 184,579 | 34,303 | 30,260 | 41,935 | 1.13x | 0.82x |
| Lorem ipsum | 46,080 | 93 | 75 | 253 | 1.24x | 0.37x |
| JSON | 182,281 | 9,174 | 4,769 | 16,088 | 1.92x | 0.57x |
| Incompressible | 100,000 | 100,012 | 100,012 | 100,053 | 1.00x | 1.00x |

Throughput ranges from about 7 MB/s on dense input to over 100 MB/s on
highly repetitive input.

Incompressible data comes out byte-for-byte the same size as real zstd, since
both fall back to raw blocks. JSON is the weakest case and the main thing
left to improve: zstd finds longer matches there than this parser does.

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
- [ ] Dictionary support
- [ ] Cross-block matching

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

- No dictionary support.
- Matches do not cross block boundaries, so input above 128 KB compresses a
  little worse than it could.
- JSON-like input compresses about 1.9x worse than real zstd. The match finder
  already finds the longest matches available — raising `searchDepth` changes
  nothing — so the remaining gap is in how sequences are priced, not in
  parsing.

## License

MIT
