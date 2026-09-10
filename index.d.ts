/// <reference types="node" />

/** Anything the compressor accepts as input. */
export type InputType = string | Buffer | Uint8Array | DataView | ArrayBuffer;

/**
 * Results are a Node `Buffer` where the runtime has one and a plain
 * `Uint8Array` otherwise. A `Buffer` is a `Uint8Array`, so code written
 * against this type works in both.
 */
export type Bytes = Uint8Array;

export interface CompressOptions {
  /**
   * Streaming only: how many already-emitted bytes stay available for later
   * blocks to match against. Defaults to one block, 128 KiB. Zero matches
   * each block on its own.
   */
  streamHistory?: number;

  /**
   * Append the frame's XXH64 content checksum, so decoders can detect
   * corruption. Costs 4 bytes. Default false.
   */
  checksum?: boolean;

  /**
   * How many candidate positions the match finder examines per position.
   * Default 32.
   *
   * This and the two below trade time for effort, not reliably for size:
   * measured across a mixed corpus, raising them costs time without
   * compressing better, and lowering them is faster but not consistently
   * larger. There is deliberately no `level` option, because levels imply a
   * monotone size curve that this parser does not have.
   */
  searchDepth?: number;

  /**
   * Consecutive candidates that may fail the first-byte check before a
   * position is written off. Default 16.
   */
  maxMisses?: number;

  /**
   * Match length at which the search stops looking for a longer one.
   * Default 64.
   */
  goodEnough?: number;

  /**
   * Farthest back a match may reference, in bytes. Default 4 MiB.
   */
  windowSize?: number;

  /**
   * A dictionary. Matches may reach into it, which helps a great deal on
   * small payloads that share structure.
   *
   * Either any buffer of representative data, or one trained by
   * `zstd --train`, whose identifier is then written into the frame.
   *
   * The resulting frame can only be read by a decoder given the same
   * dictionary — this package's `decompress`, libzstd, or `zstd -d -D`.
   */
  dictionary?: InputType;
}

/**
 * Compress into a Zstandard frame.
 *
 * The result is a standard `.zst` frame readable by any Zstandard decoder,
 * including the `zstd` CLI, Node's built-in `zlib.zstdDecompressSync` and
 * `fzstd`.
 */
export function compress(input: InputType, options?: CompressOptions): Buffer;

export interface DecompressOptions {
  /** The same dictionary the frame was compressed with. */
  dictionary?: InputType;
}

/**
 * Decompress a Zstandard stream.
 *
 * Several frames may follow one another, and skippable frames of user
 * metadata are stepped over.
 *
 * When the frame carries a content checksum it is verified, so a bad decode
 * fails instead of returning plausible-looking wrong bytes.
 *
 * @throws if the input is not a valid Zstandard frame, or if its content
 *   checksum does not match.
 */
export function decompress(input: InputType, options?: DecompressOptions): Buffer;

/**
 * Streaming compressor. Blocks are emitted as input accumulates, so neither
 * the whole input nor the whole output is held in memory.
 *
 * ```js
 * const parts = [];
 * const stream = new Compress((chunk, final) => parts.push(chunk));
 * stream.push(first);
 * stream.push(second);
 * stream.end();
 * ```
 */
export class Compress {
  constructor(
    onData: (chunk: Buffer, final: boolean) => void,
    options?: CompressOptions
  );

  /** Add input. Pass `final` on the last call to close the frame. */
  push(chunk: InputType, final?: boolean): this;

  /** Finish the frame without adding more input. */
  end(): this;
}

/**
 * Streaming decompressor, mirroring {@link Compress}. Blocks are decoded as
 * their bytes arrive rather than waiting for the whole frame.
 */
export class Decompress {
  constructor(
    onData: (chunk: Buffer, final: boolean) => void,
    options?: DecompressOptions
  );
  push(chunk: InputType, final?: boolean): this;
  end(): this;
}

/** Format constants from RFC 8878. */
export interface Constants {
  readonly MAGIC: number;

  readonly BLOCK_RAW: number;
  readonly BLOCK_RLE: number;
  readonly BLOCK_COMPRESSED: number;
  readonly BLOCK_RESERVED: number;
  readonly BLOCK_SIZE_MAX: number;

  readonly LITERALS_RAW: number;
  readonly LITERALS_RLE: number;
  readonly LITERALS_COMPRESSED: number;
  readonly LITERALS_TREELESS: number;

  readonly MODE_PREDEFINED: number;
  readonly MODE_RLE: number;
  readonly MODE_FSE: number;
  readonly MODE_REPEAT: number;

  readonly MIN_MATCH: number;

  readonly [name: string]: number | readonly number[];
}

export const constants: Constants;
