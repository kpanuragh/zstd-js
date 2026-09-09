# zstd-js

Zstandard compression in pure JavaScript. No WebAssembly, no native bindings — it runs anywhere JavaScript does, including React Native and Hermes.

> **Status: in development.** The frame, block and bitstream layers are complete and every frame this produces is accepted by the reference `zstd` CLI, by Node's native `zlib.zstdDecompressSync`, and by `fzstd`. Entropy coding is not finished yet, so output is valid Zstandard but **not yet smaller than the input** except for runs. Not published to npm.

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

| Input | Output today |
|---|---|
| 1 MB of one repeated byte | 42 bytes (RLE blocks) |
| 200 KB incompressible | 200,015 bytes (raw blocks) |
| Short text | input + ~9 bytes of framing |

Runs collapse because RLE blocks are implemented. Everything else passes through as raw blocks until the entropy coders land.

## Roadmap

- [x] Frame header: single-segment and explicit `Window_Descriptor` paths
- [x] Block framing: `Raw_Block` and `RLE_Block`
- [x] Bitstream writer and reader, with zstd's backward-read convention
- [x] Verified code tables and predefined FSE distributions
- [ ] LZ77 match finder
- [ ] FSE encoder, predefined tables
- [ ] FSE encoder, custom tables
- [ ] Huffman literal coding
- [ ] `Compressed_Block` assembly
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
