'use strict';

// Constants and code tables from RFC 8878 (Zstandard Compression and the
// application/zstd Media Type). Section numbers below refer to that document.

exports.MAGIC = 0xFD2FB528;
exports.MAGIC_SKIPPABLE_MIN = 0x184D2A50;
exports.MAGIC_SKIPPABLE_MAX = 0x184D2A5F;

// Section 3.1.1.2: Block_Type
exports.BLOCK_RAW = 0;
exports.BLOCK_RLE = 1;
exports.BLOCK_COMPRESSED = 2;
exports.BLOCK_RESERVED = 3;

// Section 3.1.1.2: a block holds at most 128 KB of regenerated data.
exports.BLOCK_SIZE_MAX = 128 * 1024;

// Section 3.1.1.3.1: Literals_Block_Type
exports.LITERALS_RAW = 0;
exports.LITERALS_RLE = 1;
exports.LITERALS_COMPRESSED = 2;
exports.LITERALS_TREELESS = 3;

// Section 3.1.1.3.2: Symbol_Compression_Mode
exports.MODE_PREDEFINED = 0;
exports.MODE_RLE = 1;
exports.MODE_FSE = 2;
exports.MODE_REPEAT = 3;

// Section 3.1.1.5: starting repeat-offset history for a frame.
exports.REPEAT_OFFSETS = [1, 4, 8];

// Section 3.1.1.3.2.1: Literals_Length_Code.
// Codes 0-15 have Baseline == code and no extra bits.
exports.LL_BASELINE = new Uint32Array([
  0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15,
  16, 18, 20, 22, 24, 28, 32, 40, 48, 64, 128, 256, 512, 1024,
  2048, 4096, 8192, 16384, 32768, 65536
]);
exports.LL_BITS = new Uint8Array([
  0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
  1, 1, 1, 1, 2, 2, 3, 3, 4, 6, 7, 8, 9, 10,
  11, 12, 13, 14, 15, 16
]);

// Section 3.1.1.3.2.1: Match_Length_Code.
// Codes 0-31 have Baseline == code + 3 and no extra bits.
exports.ML_BASELINE = new Uint32Array([
  3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18,
  19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30, 31, 32, 33, 34,
  35, 37, 39, 41, 43, 47, 51, 59, 67, 83, 99, 131, 259, 515, 1027,
  2051, 4099, 8195, 16387, 32771, 65539
]);
exports.ML_BITS = new Uint8Array([
  0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
  0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
  1, 1, 1, 1, 2, 2, 3, 3, 4, 4, 5, 7, 8, 9, 10,
  11, 12, 13, 14, 15, 16
]);

// Section 3.1.1.3.2.1: an offset code N carries N extra bits, and
// Offset_Value = (1 << N) + extra_bits.
exports.OFFSET_CODE_MAX = 31;

// Section 3.1.1.3.2.2: predefined distributions. A value of -1 means
// "probability less than 1", which occupies a single low-probability state.
exports.LL_DEFAULT_ACCURACY = 6;
exports.LL_DEFAULT_DISTRIBUTION = [
  4, 3, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 1, 1, 1,
  2, 2, 2, 2, 2, 2, 2, 2, 2, 3, 2, 1, 1, 1, 1, 1,
  -1, -1, -1, -1
];

exports.ML_DEFAULT_ACCURACY = 6;
exports.ML_DEFAULT_DISTRIBUTION = [
  1, 4, 3, 2, 2, 2, 2, 2, 2, 1, 1, 1, 1, 1, 1, 1,
  1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1,
  1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, -1, -1,
  -1, -1, -1, -1, -1
];

exports.OF_DEFAULT_ACCURACY = 5;
exports.OF_DEFAULT_DISTRIBUTION = [
  1, 1, 1, 1, 1, 1, 2, 2, 2, 1, 1, 1, 1, 1, 1, 1,
  1, 1, 1, 1, 1, 1, 1, 1, -1, -1, -1, -1, -1
];

// Section 4.1: accuracy log limits.
exports.LL_FSE_ACCURACY_MAX = 9;
exports.ML_FSE_ACCURACY_MAX = 9;
exports.OF_FSE_ACCURACY_MAX = 8;

exports.LL_SYMBOL_MAX = 35;
exports.ML_SYMBOL_MAX = 52;
exports.OF_SYMBOL_MAX = 31;

// Section 4.2: Huffman limits.
exports.HUF_MAX_SYMBOLS = 256;
exports.HUF_MAX_BITS = 11;

// Minimum match length zstd's sequence format can express (Match_Length_Code 0
// has a baseline of 3).
exports.MIN_MATCH = 3;
