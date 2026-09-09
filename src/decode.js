'use strict';

// Zstandard frame decoding (RFC 8878 Section 3).

var c = require('./constants');
var fseDecode = require('./fse-decode');
var huffmanDecode = require('./huffman-decode');
var repcodes = require('./repcodes');
var dictionaryFormat = require('./dictionary');
var xxhash = require('./xxhash64');
var BitReader = require('./bitstream').BitReader;

var POW2 = new Float64Array(33);
for (var p2 = 0; p2 < 33; p2++) POW2[p2] = Math.pow(2, p2);

var MASKS = new Int32Array(26);
for (var mk = 1; mk <= 25; mk++) MASKS[mk] = (1 << mk) - 1;

// Bytes of zero padding placed on each side of a bitstream before decoding.
// With them, a four-byte read is always in bounds, so the extraction below
// needs no edge cases and stays small enough for V8 to inline.
var PAD = 4;

/**
 * Read `nbBits` ending at bit `pos` of a padded stream. Up to 25 bits, which
 * is what a 32-bit word covers alongside a seven-bit offset.
 */
function extract(bytes, pos, nbBits) {
  if (nbBits === 0) return 0;

  var low = pos - nbBits + 1;
  var byteIndex = low >> 3;
  var word = bytes[byteIndex] |
    (bytes[byteIndex + 1] << 8) |
    (bytes[byteIndex + 2] << 16) |
    (bytes[byteIndex + 3] << 24);

  return (word >>> (low & 7)) & MASKS[nbBits];
}

/** Copy a bitstream with padding on both sides. */
function padStream(stream) {
  var padded = Buffer.alloc(stream.length + PAD * 2);
  stream.copy(padded, PAD);
  return padded;
}

var DICT_ID_SIZE = [0, 1, 2, 4];
var FCS_SIZE = [0, 2, 4, 8];

/** Parse a frame header (Section 3.1.1.1). */
function parseFrameHeader(bytes, offset) {
  if (bytes.length - offset < 5) throw new Error('truncated frame header');
  if (bytes.readUInt32LE(offset) !== c.MAGIC) throw new Error('not a Zstandard frame');

  var at = offset + 4;
  var descriptor = bytes[at++];

  var fcsFlag = descriptor >> 6;
  var singleSegment = (descriptor >> 5) & 1;
  var checksumFlag = (descriptor >> 2) & 1;
  var dictIdFlag = descriptor & 3;

  if ((descriptor >> 3) & 1) throw new Error('reserved bit set in frame header');

  var windowSize = 0;
  if (!singleSegment) {
    var windowDescriptor = bytes[at++];
    var exponent = windowDescriptor >> 3;
    var mantissa = windowDescriptor & 7;
    var base = Math.pow(2, 10 + exponent);
    windowSize = base + (base / 8) * mantissa;
  }

  var dictionaryId = 0;
  var dictIdSize = DICT_ID_SIZE[dictIdFlag];
  for (var d = 0; d < dictIdSize; d++) dictionaryId |= bytes[at + d] << (8 * d);
  at += dictIdSize;

  var contentSize = null;
  var fcsSize = fcsFlag === 0 ? (singleSegment ? 1 : 0) : FCS_SIZE[fcsFlag];
  if (fcsSize === 1) contentSize = bytes[at];
  else if (fcsSize === 2) contentSize = bytes.readUInt16LE(at) + 256;
  else if (fcsSize === 4) contentSize = bytes.readUInt32LE(at);
  else if (fcsSize === 8) contentSize = Number(bytes.readBigUInt64LE(at));
  at += fcsSize;

  if (singleSegment && contentSize !== null) windowSize = contentSize;

  return {
    headerSize: at - offset,
    windowSize: windowSize,
    contentSize: contentSize,
    checksum: checksumFlag === 1,
    dictionaryId: dictionaryId
  };
}

/** Decode a Literals_Section, returning the literals and bytes consumed. */
function decodeLiterals(bytes, offset, previousTable) {
  var header = bytes[offset];
  var type = header & 3;
  var sizeFormat = (header >> 2) & 3;

  if (type === c.LITERALS_RAW || type === c.LITERALS_RLE) {
    var regenerated, headerSize;
    if ((sizeFormat & 1) === 0) {
      regenerated = header >> 3;
      headerSize = 1;
    } else if (sizeFormat === 1) {
      regenerated = (header >> 4) + (bytes[offset + 1] << 4);
      headerSize = 2;
    } else {
      regenerated = (header >> 4) + (bytes[offset + 1] << 4) + (bytes[offset + 2] << 12);
      headerSize = 3;
    }

    if (type === c.LITERALS_RAW) {
      return {
        literals: bytes.subarray(offset + headerSize, offset + headerSize + regenerated),
        size: headerSize + regenerated,
        table: previousTable
      };
    }
    return {
      literals: Buffer.alloc(regenerated, bytes[offset + headerSize]),
      size: headerSize + 1,
      table: previousTable
    };
  }

  // Compressed or treeless: both sizes are present, and the stream count and
  // field widths follow the size format.
  var streams = sizeFormat === 0 ? 1 : 4;
  var regen, compressed, size;

  if (sizeFormat === 0 || sizeFormat === 1) {
    var v3 = header + (bytes[offset + 1] << 8) + (bytes[offset + 2] << 16);
    regen = (v3 >> 4) & 0x3FF;
    compressed = (v3 >> 14) & 0x3FF;
    size = 3;
  } else if (sizeFormat === 2) {
    var v4 = header + (bytes[offset + 1] << 8) + (bytes[offset + 2] << 16) + bytes[offset + 3] * 16777216;
    regen = Math.floor(v4 / 16) % 16384;
    compressed = Math.floor(v4 / 262144) % 16384;
    size = 4;
  } else {
    var v5 = header + bytes[offset + 1] * 256 + bytes[offset + 2] * 65536 +
      bytes[offset + 3] * 16777216 + bytes[offset + 4] * 4294967296;
    regen = Math.floor(v5 / 16) % 262144;
    compressed = Math.floor(v5 / 4194304) % 262144;
    size = 5;
  }

  var contentStart = offset + size;
  var table = previousTable;
  var streamStart = contentStart;

  if (type === c.LITERALS_COMPRESSED) {
    var tree = huffmanDecode.readTreeDescription(bytes, contentStart);
    table = huffmanDecode.buildDecodeTable(tree.nbBits, tree.maxBits);
    streamStart = contentStart + tree.size;
  } else if (!table) {
    throw new Error('treeless literals with no previous Huffman table');
  }

  var literals = Buffer.alloc(regen);
  var streamsEnd = contentStart + compressed;

  if (streams === 1) {
    huffmanDecode.decodeStream(bytes.subarray(streamStart, streamsEnd), table, regen, literals, 0);
  } else {
    var s1 = bytes.readUInt16LE(streamStart);
    var s2 = bytes.readUInt16LE(streamStart + 2);
    var s3 = bytes.readUInt16LE(streamStart + 4);
    var p = streamStart + 6;
    var segment = (regen + 3) >> 2;

    huffmanDecode.decodeStream(bytes.subarray(p, p + s1), table, segment, literals, 0); p += s1;
    huffmanDecode.decodeStream(bytes.subarray(p, p + s2), table, segment, literals, segment); p += s2;
    huffmanDecode.decodeStream(bytes.subarray(p, p + s3), table, segment, literals, 2 * segment); p += s3;
    huffmanDecode.decodeStream(bytes.subarray(p, streamsEnd), table, regen - 3 * segment, literals, 3 * segment);
  }

  return { literals: literals, size: size + compressed, table: table };
}

function readSequenceCount(bytes, offset) {
  var first = bytes[offset];
  if (first === 0) return { count: 0, size: 1 };
  if (first < 128) return { count: first, size: 1 };
  if (first < 255) return { count: ((first - 128) << 8) + bytes[offset + 1], size: 2 };
  return { count: bytes[offset + 1] + (bytes[offset + 2] << 8) + 0x7F00, size: 3 };
}

function tableForMode(mode, bytes, offset, defaults, previous, maxSymbol, maxAccuracy) {
  if (mode === c.MODE_PREDEFINED) {
    return { table: defaults, size: 0 };
  }
  if (mode === c.MODE_RLE) {
    return { table: fseDecode.rleDTable(bytes[offset]), size: 1 };
  }
  if (mode === c.MODE_REPEAT) {
    if (!previous) throw new Error('repeat mode with no previous table');
    return { table: previous, size: 0 };
  }
  var description = fseDecode.readTableDescription(bytes, offset, maxSymbol, maxAccuracy);
  return {
    table: fseDecode.buildDTable(description.normalized, description.accuracyLog, description.maxSymbol),
    size: description.size
  };
}


// Predefined decoding tables, built once.
var LL_DEFAULT = fseDecode.buildDTable(
  Int16Array.from(c.LL_DEFAULT_DISTRIBUTION), c.LL_DEFAULT_ACCURACY, c.LL_SYMBOL_MAX);
var ML_DEFAULT = fseDecode.buildDTable(
  Int16Array.from(c.ML_DEFAULT_DISTRIBUTION), c.ML_DEFAULT_ACCURACY, c.ML_SYMBOL_MAX);
var OF_DEFAULT = fseDecode.buildDTable(
  Int16Array.from(c.OF_DEFAULT_DISTRIBUTION), c.OF_DEFAULT_ACCURACY, 28);

/**
 * Decode a Sequences_Section.
 *
 * Reading mirrors the encoder exactly: the three states come first, then for
 * each sequence the offset, match length and literal length extras, then the
 * state updates - except after the final sequence, which has none.
 */
function decodeSequences(bytes, offset, end, tables) {
  var counted = readSequenceCount(bytes, offset);
  var at = offset + counted.size;

  if (counted.count === 0) {
    return { count: 0, tables: tables };
  }

  var modes = bytes[at++];
  var llMode = modes >> 6;
  var ofMode = (modes >> 4) & 3;
  var mlMode = (modes >> 2) & 3;
  if ((modes & 3) !== 0) throw new Error('reserved bits set in Symbol_Compression_Modes');

  var ll = tableForMode(llMode, bytes, at, LL_DEFAULT, tables.ll, c.LL_SYMBOL_MAX, c.LL_FSE_ACCURACY_MAX);
  at += ll.size;
  var of = tableForMode(ofMode, bytes, at, OF_DEFAULT, tables.of, c.OF_SYMBOL_MAX, c.OF_FSE_ACCURACY_MAX);
  at += of.size;
  var ml = tableForMode(mlMode, bytes, at, ML_DEFAULT, tables.ml, c.ML_SYMBOL_MAX, c.ML_FSE_ACCURACY_MAX);
  at += ml.size;

  var raw = bytes.subarray(at, end);
  var reader = new BitReader(raw);

  // Work on a padded copy so every read is a plain in-bounds word load.
  var stream = padStream(raw);
  var position = reader.pos + PAD * 8;

  var llState = extract(stream, position, ll.table.accuracyLog);
  position -= ll.table.accuracyLog;
  var ofState = extract(stream, position, of.table.accuracyLog);
  position -= of.table.accuracyLog;
  var mlState = extract(stream, position, ml.table.accuracyLog);
  position -= ml.table.accuracyLog;

  var llSymbols = ll.table.symbol, llBits = ll.table.bits, llBase = ll.table.base;
  var ofSymbols = of.table.symbol, ofBits = of.table.bits, ofBase = of.table.base;
  var mlSymbols = ml.table.symbol, mlBits = ml.table.bits, mlBase = ml.table.base;

  var LL_BASE = c.LL_BASELINE, LL_EXTRA = c.LL_BITS;
  var ML_BASE = c.ML_BASELINE, ML_EXTRA = c.ML_BITS;

  // Flat arrays rather than an object per sequence: a dense block holds
  // thousands of them, and the allocation shows up in profiles.
  var literalLengths = new Uint32Array(counted.count);
  var matchLengths = new Uint32Array(counted.count);
  var offBases = new Uint32Array(counted.count);

  var lastIndex = counted.count - 1;

  for (var i = 0; i < counted.count; i++) {
    var llCode = llSymbols[llState];
    var mlCode = mlSymbols[mlState];
    var ofCode = ofSymbols[ofState];

    // An offset code can exceed the 25-bit fast path, so it goes through the
    // reader; the rest never do.
    // An offset code can exceed what one word covers, so it is taken in two
    // parts, the more significant first.
    if (ofCode > 25) {
      var high = extract(stream, position, ofCode - 16);
      position -= ofCode - 16;
      offBases[i] = POW2[ofCode] + high * 65536 + extract(stream, position, 16);
      position -= 16;
    } else {
      offBases[i] = POW2[ofCode] + extract(stream, position, ofCode);
      position -= ofCode;
    }

    var mlExtra = ML_EXTRA[mlCode];
    matchLengths[i] = ML_BASE[mlCode] + extract(stream, position, mlExtra);
    position -= mlExtra;

    var llExtra = LL_EXTRA[llCode];
    literalLengths[i] = LL_BASE[llCode] + extract(stream, position, llExtra);
    position -= llExtra;

    if (i < lastIndex) {
      var llNb = llBits[llState];
      llState = llBase[llState] + extract(stream, position, llNb);
      position -= llNb;

      var mlNb = mlBits[mlState];
      mlState = mlBase[mlState] + extract(stream, position, mlNb);
      position -= mlNb;

      var ofNb = ofBits[ofState];
      ofState = ofBase[ofState] + extract(stream, position, ofNb);
      position -= ofNb;
    }
  }

  return {
    count: counted.count,
    literalLengths: literalLengths,
    matchLengths: matchLengths,
    offBases: offBases,
    tables: { ll: ll.table, of: of.table, ml: ml.table }
  };
}

/**
 * Turn sequences and literals into output bytes (Section 3.1.1.4).
 *
 * `output` already holds everything decoded so far, including any dictionary,
 * because matches reach back into it.
 */
function executeSequences(decoded, literals, output, written, reps) {
  var literalPosition = 0;
  var count = decoded.count;
  var literalLengths = decoded.literalLengths;
  var matchLengths = decoded.matchLengths;
  var offBases = decoded.offBases;

  var rep0 = reps[0];
  var rep1 = reps[1];
  var rep2 = reps[2];

  for (var i = 0; i < count; i++) {
    var literalLength = literalLengths[i];
    var matchLength = matchLengths[i];
    var offBase = offBases[i];
    var offset;

    if (offBase > 3) {
      offset = offBase - 3;
      rep2 = rep1; rep1 = rep0; rep0 = offset;
    } else {
      // Section 3.1.1.5: with no literals the three slots shift by one, and
      // code 3 then means the most recent offset minus one.
      var index = offBase - 1 + (literalLength === 0 ? 1 : 0);
      offset = index === 0 ? rep0 : index === 1 ? rep1 : index === 2 ? rep2 : rep0 - 1;
      if (offset <= 0) throw new Error('invalid repeat offset');

      if (index !== 0) {
        var previous = rep0;
        if (index >= 2) rep2 = rep1;
        rep1 = previous;
        rep0 = offset;
      }
    }

    if (literalLength > 0) {
      if (literalLength < 24) {
        for (var l = 0; l < literalLength; l++) output[written + l] = literals[literalPosition + l];
      } else {
        literals.copy(output, written, literalPosition, literalPosition + literalLength);
      }
      literalPosition += literalLength;
      written += literalLength;
    }

    if (offset > written) throw new Error('match offset reaches before the start of the stream');

    var from = written - offset;

    if (offset >= matchLength) {
      // Source and destination do not overlap, so this is a plain block move.
      output.copy(output, written, from, from + matchLength);
    } else {
      // An overlapping match means "repeat what you just wrote". Lay down one
      // period, then double the region repeatedly: because the run is
      // periodic with this offset, everything already written can be copied
      // forward in one go. A long run at a short offset takes a handful of
      // copies instead of thousands.
      if (offset < 16) {
        for (var p = 0; p < offset; p++) output[written + p] = output[from + p];
      } else {
        output.copy(output, written, from, from + offset);
      }

      var filled = offset;
      while (filled < matchLength) {
        var span = filled < matchLength - filled ? filled : matchLength - filled;
        output.copy(output, written + filled, written, written + span);
        filled += span;
      }
    }
    written += matchLength;
  }

  var tail = literals.length - literalPosition;
  if (tail > 0) {
    literals.copy(output, written, literalPosition, literals.length);
    written += tail;
  }

  return { written: written, reps: [rep0, rep1, rep2] };
}

/**
 * Decode every frame in `bytes` and join the results.
 *
 * A Zstandard stream may hold several frames back to back, and may carry
 * skippable frames - user metadata that decoders step over.
 */
function decodeFrame(bytes, options) {
  var pieces = [];
  var at = 0;
  var total = 0;

  while (at < bytes.length) {
    if (bytes.length - at < 4) throw new Error('trailing bytes are not a frame');

    var magic = bytes.readUInt32LE(at);

    // Section 3.1.2: a skippable frame is a magic in the reserved range
    // followed by its size, and carries nothing a decoder needs.
    if (magic >= c.MAGIC_SKIPPABLE_MIN && magic <= c.MAGIC_SKIPPABLE_MAX) {
      if (bytes.length - at < 8) throw new Error('truncated skippable frame');
      var skipSize = bytes.readUInt32LE(at + 4);
      at += 8 + skipSize;
      if (at > bytes.length) throw new Error('skippable frame runs past the end');
      continue;
    }

    var decoded = decodeSingleFrame(bytes, at, options);
    pieces.push(decoded.content);
    total += decoded.content.length;
    at = decoded.end;
  }

  if (pieces.length === 0) throw new Error('not a Zstandard frame');
  if (pieces.length === 1) return pieces[0];
  return Buffer.concat(pieces, total);
}

/**
 * Decode the frame starting at `offset`.
 *
 * @returns {{content: Buffer, end: number}}
 */
function decodeSingleFrame(bytes, offset, options) {
  options = options || {};
  var parsed = options.dictionary
    ? dictionaryFormat.parse(options.dictionary)
    : dictionaryFormat.parse(Buffer.alloc(0));
  var dictionary = parsed.content;

  var header = parseFrameHeader(bytes, offset);
  var at = offset + header.headerSize;

  // Output is preceded by the dictionary, so matches can reach into it.
  var capacity = dictionary.length +
    (header.contentSize !== null ? header.contentSize : Math.max((bytes.length - at) * 8, 1 << 20));
  var output = Buffer.alloc(capacity);
  dictionary.copy(output, 0);

  var written = dictionary.length;

  // A formal dictionary supplies starting repeat offsets and entropy tables
  // for the repeat modes; a raw one supplies only content.
  var reps = parsed.reps.slice();
  var tables = { ll: parsed.tables.ll, of: parsed.tables.of, ml: parsed.tables.ml };
  var huffmanTable = parsed.huffman;

  for (;;) {
    if (at + 3 > bytes.length) throw new Error('truncated block header');

    var blockHeader = bytes.readUIntLE(at, 3);
    at += 3;

    var last = blockHeader & 1;
    var type = (blockHeader >> 1) & 3;
    var size = blockHeader >> 3;

    if (type === c.BLOCK_RAW) {
      output = ensure(output, written + size);
      bytes.copy(output, written, at, at + size);
      written += size;
      at += size;
    } else if (type === c.BLOCK_RLE) {
      output = ensure(output, written + size);
      output.fill(bytes[at], written, written + size);
      written += size;
      at += 1;
    } else if (type === c.BLOCK_COMPRESSED) {
      var blockEnd = at + size;
      var decoded = decodeLiterals(bytes, at, huffmanTable);
      huffmanTable = decoded.table;

      var seq = decodeSequences(bytes, at + decoded.size, blockEnd, tables);
      tables = seq.tables;

      output = ensure(output, written + decoded.literals.length + totalMatch(seq));

      var result = executeSequences(seq, decoded.literals, output, written, reps);
      written = result.written;
      reps = result.reps;
      at = blockEnd;
    } else {
      throw new Error('reserved block type');
    }

    if (last) break;
  }

  var content = output.subarray(dictionary.length, written);

  if (header.checksum) {
    if (at + 4 > bytes.length) throw new Error('missing content checksum');
    var stored = bytes.readUInt32LE(at);
    if (stored !== xxhash.checksum32(content)) {
      throw new Error('content checksum mismatch');
    }
  }

  if (header.checksum) at += 4;

  // Returning the view avoids copying the whole output again. It is only
  // worth copying when the buffer is much larger than what was decoded.
  return {
    content: output.length - written > (written >> 2) ? Buffer.from(content) : content,
    end: at
  };
}

function totalMatch(decoded) {
  var sum = 0;
  var lengths = decoded.matchLengths;
  for (var i = 0; i < decoded.count; i++) sum += lengths[i];
  return sum;
}

function ensure(buffer, needed) {
  if (needed <= buffer.length) return buffer;
  var size = buffer.length * 2;
  while (size < needed) size *= 2;
  var next = Buffer.alloc(size);
  buffer.copy(next);
  return next;
}

/**
 * Incremental frame decoder.
 *
 * Blocks are decoded as their bytes arrive, so input does not have to be
 * complete before output starts. Decoded output is retained because matches
 * reach back into it.
 */
function StreamingDecoder(onData, options) {
  options = options || {};
  this.onData = onData;
  this.dictionary = options.dictionary || Buffer.alloc(0);

  var parsedDictionary = dictionaryFormat.parse(this.dictionary);
  this.dictionary = parsedDictionary.content;

  this.input = Buffer.alloc(0);
  this.consumed = 0;

  this.header = null;
  this.output = Buffer.alloc(Math.max(this.dictionary.length * 2, 1 << 16));
  this.dictionary.copy(this.output, 0);
  this.written = this.dictionary.length;
  this.emitted = this.dictionary.length;

  this.reps = parsedDictionary.reps.slice();
  this.tables = {
    ll: parsedDictionary.tables.ll,
    of: parsedDictionary.tables.of,
    ml: parsedDictionary.tables.ml
  };
  this.huffmanTable = parsedDictionary.huffman;
  this.lastBlockSeen = false;
  this.done = false;
}

StreamingDecoder.prototype.push = function (chunk, final) {
  if (this.done) {
    if (chunk && chunk.length) throw new Error('push after the frame ended');
    return this;
  }

  this.input = this.consumed > 0
    ? Buffer.concat([this.input.subarray(this.consumed), chunk])
    : Buffer.concat([this.input, chunk]);
  this.consumed = 0;

  this._advance();

  if (final && !this.done) {
    throw new Error('input ended before the frame was complete');
  }
  return this;
};

StreamingDecoder.prototype._advance = function () {
  // The last block may arrive before the trailing checksum does.
  if (this.lastBlockSeen) {
    this._finish();
    return;
  }

  if (this.header === null) {
    // The header is at most 14 bytes; wait until it can be read whole.
    if (this.input.length < 6) return;
    try {
      this.header = parseFrameHeader(this.input, 0);
    } catch (e) {
      if (this.input.length < 18) return;
      throw e;
    }
    this.consumed = this.header.headerSize;
  }

  for (;;) {
    var available = this.input.length - this.consumed;
    if (available < 3) return;

    var blockHeader = this.input.readUIntLE(this.consumed, 3);
    var last = blockHeader & 1;
    var type = (blockHeader >> 1) & 3;
    var size = blockHeader >> 3;

    var bodySize = type === c.BLOCK_RLE ? 1 : size;
    if (available < 3 + bodySize) return;

    var at = this.consumed + 3;

    if (type === c.BLOCK_RAW) {
      this.output = ensure(this.output, this.written + size);
      this.input.copy(this.output, this.written, at, at + size);
      this.written += size;
    } else if (type === c.BLOCK_RLE) {
      this.output = ensure(this.output, this.written + size);
      this.output.fill(this.input[at], this.written, this.written + size);
      this.written += size;
    } else if (type === c.BLOCK_COMPRESSED) {
      var blockEnd = at + size;
      var decoded = decodeLiterals(this.input, at, this.huffmanTable);
      this.huffmanTable = decoded.table;

      var seq = decodeSequences(this.input, at + decoded.size, blockEnd, this.tables);
      this.tables = seq.tables;

      this.output = ensure(this.output, this.written + decoded.literals.length + totalMatch(seq));

      var result = executeSequences(seq, decoded.literals, this.output, this.written, this.reps);
      this.written = result.written;
      this.reps = result.reps;
    } else {
      throw new Error('reserved block type');
    }

    this.consumed = 3 + bodySize + this.consumed;

    if (last) {
      this.lastBlockSeen = true;
      this._finish();
      return;
    }

    this._flush(false);
  }
};

StreamingDecoder.prototype._flush = function (final) {
  if (this.written > this.emitted || final) {
    var chunk = Buffer.from(this.output.subarray(this.emitted, this.written));
    this.emitted = this.written;
    this.onData(chunk, final);
  }
};

StreamingDecoder.prototype._finish = function () {
  if (this.header.checksum) {
    // Wait for the trailing checksum rather than failing on a short read.
    if (this.input.length - this.consumed < 4) return;
    var stored = this.input.readUInt32LE(this.consumed);
    var content = this.output.subarray(this.dictionary.length, this.written);
    if (stored !== xxhash.checksum32(content)) {
      throw new Error('content checksum mismatch');
    }
    this.consumed += 4;
  }

  this.done = true;
  this._flush(true);
};

exports.StreamingDecoder = StreamingDecoder;
exports.decodeFrame = decodeFrame;
exports.decodeSingleFrame = decodeSingleFrame;
exports.decodeSequences = decodeSequences;
exports.executeSequences = executeSequences;

exports.parseFrameHeader = parseFrameHeader;
exports.decodeLiterals = decodeLiterals;
exports.readSequenceCount = readSequenceCount;
exports.tableForMode = tableForMode;
