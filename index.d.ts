/// <reference types="node" />

/** Anything the compressor accepts as input. */
export type InputType = string | Buffer | Uint8Array | DataView | ArrayBuffer;

export interface CompressOptions {
  /**
   * Append the frame's XXH64 content checksum, so decoders can detect
   * corruption. Costs 4 bytes. Default false.
   */
  checksum?: boolean;

  /**
   * How many candidate positions the match finder examines per position.
   * Higher values compress a little better and run slower. Default 32.
   */
  searchDepth?: number;

  /**
   * Farthest back a match may reference, in bytes. Default 4 MiB.
   */
  windowSize?: number;

  /**
   * Raw-content dictionary. Matches may reach into it, which helps a great
   * deal on small payloads that share structure.
   *
   * Note that the resulting frame can only be read by a decoder given the
   * same dictionary — libzstd, or `zstd -d -D <dict>`. This package's own
   * `decompress` cannot read them.
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
  /**
   * Not supported. Passing a dictionary throws, rather than silently
   * returning wrong bytes.
   */
  dictionary?: never;
}

/**
 * Decompress a Zstandard frame.
 *
 * When the frame carries a content checksum it is verified, so a bad decode
 * fails instead of returning plausible-looking wrong bytes.
 *
 * @throws if the input is not a valid Zstandard frame, if the checksum does
 *   not match, or if a dictionary is passed.
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

/** Streaming decompressor, mirroring {@link Compress}. */
export class Decompress {
  constructor(onData: (chunk: Buffer, final: boolean) => void);
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
