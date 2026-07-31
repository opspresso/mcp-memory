/**
 * Time-sortable identifiers, and the inverted form the recency index needs.
 *
 * ULID rather than a UUID because S3 has no secondary index and no ORDER BY:
 * the only ordering available is the lexicographic one `ListObjectsV2` walks,
 * so the key has to carry the time. A ULID's first ten characters are the
 * millisecond timestamp in Crockford base32, which sorts in the same order as
 * the instants it encodes.
 *
 * Hand-written rather than a dependency for the reason the sibling server gives
 * for its protocol handler: the surface is two functions, and the encoding is
 * fixed by a spec that cannot drift under it.
 */

import { randomBytes } from "node:crypto";

const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const TIME_CHARS = 10;
const RANDOM_CHARS = 16;
/** 48 bits, the ULID timestamp width — and the ceiling the inverted form counts down from. */
const MAX_TIME = 2 ** 48 - 1;

function encodeTime(ms: number, length: number): string {
  let remaining = ms;
  let out = "";
  for (let i = 0; i < length; i++) {
    out = ALPHABET[remaining % 32] + out;
    remaining = Math.floor(remaining / 32);
  }
  return out;
}

function encodeRandom(length: number): string {
  const bytes = randomBytes(length);
  let out = "";
  for (let i = 0; i < length; i++) {
    // One byte per character, folded into the alphabet. Wastes three bits of
    // each byte, which costs nothing here and keeps the mapping obvious.
    out += ALPHABET[bytes[i]! % 32];
  }
  return out;
}

/**
 * A ULID for `at` (default now). Two ULIDs from the same millisecond order
 * arbitrarily against each other, which is fine: nothing here depends on
 * distinguishing two memories written inside one tick.
 */
export function ulid(at: number = Date.now()): string {
  if (!Number.isFinite(at) || at < 0 || at > MAX_TIME) {
    throw new RangeError(`timestamp out of ULID range: ${at}`);
  }
  return encodeTime(Math.floor(at), TIME_CHARS) + encodeRandom(RANDOM_CHARS);
}

/** The millisecond a ULID encodes, or NaN if it is not one. */
export function ulidTime(id: string): number {
  if (id.length !== TIME_CHARS + RANDOM_CHARS) {
    return NaN;
  }
  let ms = 0;
  for (let i = 0; i < TIME_CHARS; i++) {
    const digit = ALPHABET.indexOf(id[i]!);
    if (digit < 0) {
      return NaN;
    }
    ms = ms * 32 + digit;
  }
  return ms;
}

/**
 * A timestamp encoded so that *newer* sorts *first*.
 *
 * `ListObjectsV2` only walks ascending, and there is no reverse. Counting down
 * from the 48-bit ceiling is what turns "list the first page" into "the most
 * recent memories" — without it, listing recent items would mean paging to the
 * end of the whole prefix every time.
 */
export function invertedTime(at: number = Date.now()): string {
  if (!Number.isFinite(at) || at < 0 || at > MAX_TIME) {
    throw new RangeError(`timestamp out of ULID range: ${at}`);
  }
  return encodeTime(MAX_TIME - Math.floor(at), TIME_CHARS);
}
