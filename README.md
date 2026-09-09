# zstd-js

Zstandard compression in pure JavaScript. No WebAssembly, no native bindings — it runs anywhere JavaScript does, including React Native and Hermes.

> **Status: in development.** LZ77 matching and FSE-coded sequences are working, so this genuinely compresses. Every frame is verified against libzstd. Literals are still stored uncompressed — Huffman coding is next — so ratios trail real zstd on data with diverse literals. Not published to npm.

## Why

Every Zstandard implementation for JavaScript is either a native binding or a WebAssembly build. That leaves two gaps:

- **React Native.** Hermes has no WebAssembly, so none of the WASM packages run there.
- **Synchronous APIs.** WASM modules need asynchronous initialisation, which cannot back a `compressSync`.

Decoding is already solved in pure JS by [`fzstd`](https://github.com/101arrowz/fzstd). Encoding is not — there is no pure-JavaScript Zstandard compressor on npm. That is what this is.

## Current behaviour

```js
const zstd = require('zstd-js');

const frame = zstd.compress('hello world');
// -> a valid .zst frame, readable by any Zstandard decoder
```

Measured against Node's native Zstandard and gzip:

| Input | Original | zstd-js | zstd | gzip |
|---|---|---|---|---|
| English text | 45,000 | **64** | 66 | 213 |
| Source-like text | 92,500 | **94** | 89 | 422 |
| DNA-like, 4 symbols | 100,000 | **13** | 22 | 132 |
| JSON | 182,281 | 25,778 | 4,769 | 16,088 |
| Incompressible | 100,000 | 100,012 | 100,012 | 100,043 |

Highly repetitive input already matches or beats real zstd, because long matches dominate and the sequence coder is complete. JSON is where the gap shows: its literals are diverse, and until Huffman coding lands they are stored raw. That is the next piece of work.

## Roadmap

- [x] Frame header: single-segment and explicit `Window_Descriptor` paths
- [x] Block framing: `Raw_Block` and `RLE_Block`
- [x] Bitstream writer and reader, with zstd's backward-read convention
- [x] Verified code tables and predefined FSE distributions
- [x] LZ77 match finder, hash chains with configurable search depth
- [x] FSE encoder, predefined tables
- [x] `Compressed_Block` assembly, with fallback to raw when it would not help
- [ ] Huffman literal coding
- [ ] FSE encoder, custom tables
- [ ] xxhash64 content checksum
- [ ] Streaming API
- [ ] Dictionary support

## Design notes

Everything is written against [RFC 8878](https://www.rfc-editor.org/rfc/rfc8878.txt), and the code tables carry self-checks: the predefined distributions must sum to `2^accuracy_log`, and the literal-length and match-length baselines must be contiguous under their extra-bit widths. Those checks caught a transcription error during development.

The bitstream is the part most likely to be subtly wrong, so it is fuzzed: 5,000 randomised field sequences are written and read back per test run.

## Testing

```bash
npm test
```

Every frame produced is round-tripped through Node's native Zstandard, which is libzstd itself, so correctness is measured against the reference implementation rather than against this package's own decoder.

## License

MIT
