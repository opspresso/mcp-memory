/**
 * Time-sortable identifiers. PostgreSQL also stores `created_at`, while the
 * timestamp prefix keeps ids useful in logs and stable ordering tie-breaks.
 *
 * Hand-written rather than a dependency for the reason the sibling server gives
 * for its protocol handler: the surface is two functions, and the encoding is
 * fixed by a spec that cannot drift under it.
 */

import { randomBytes } from "node:crypto";

const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const TIME_CHARS = 10;
const RANDOM_CHARS = 16;
/** 48 bits, the ULID timestamp width. */
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
