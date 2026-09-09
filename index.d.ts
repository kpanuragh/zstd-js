/// <reference types="node" />

/** Anything the compressor accepts as input. */
export type InputType = string | Buffer | Uint8Array | DataView | ArrayBuffer;

export interface CompressOptions {
  /**
   * How many candidate positions the match finder examines per position.
   * Higher values compress a little better and run slower. Default 32.
   */
  searchDepth?: number;

  /**
   * Farthest back a match may reference, in bytes. Default 4 MiB.
   */
  windowSize?: number;
}

/**
 * Compress into a Zstandard frame.
 *
 * The result is a standard `.zst` frame readable by any Zstandard decoder,
 * including the `zstd` CLI, Node's built-in `zlib.zstdDecompressSync` and
 * `fzstd`.
 */
export function compress(input: InputType, options?: CompressOptions): Buffer;

/**
 * Decompress a Zstandard frame.
 *
 * @throws if the input is not a valid Zstandard frame.
 */
export function decompress(input: InputType): Buffer;

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
