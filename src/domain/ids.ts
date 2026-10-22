import { randomBytes, randomUUID } from 'node:crypto';

/**
 * Identifier generation.
 *
 * Order IDs are human-quotable but must not be guessable: the suffix is 10
 * CSPRNG bytes (80 bits) rendered as Crockford base32. The date prefix is for
 * operator convenience only; uniqueness rests on the random suffix plus a
 * database UNIQUE constraint.
 */

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'; // no I, L, O, U

export function randomToken(byteLength = 32): string {
  return randomBytes(byteLength).toString('base64url');
}

export function base32(bytes: Buffer, length: number): string {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += CROCKFORD[(value >>> (bits - 5)) & 31];
      bits -= 5;
      if (out.length === length) return out;
    }
  }
  if (out.length < length && bits > 0) {
    out += CROCKFORD[(value << (5 - bits)) & 31];
  }
  return out.slice(0, length);
}

export const ORDER_ID_SUFFIX_LENGTH = 8; // 8 chars of Crockford = 40 bits shown
const ORDER_ID_RANDOM_BYTES = 10; // 80 bits of entropy behind the suffix

/** PAY-YYYYMMDD-XXXXXXXX — the suffix is random, never sequential. */
export function generateOrderId(now: Date = new Date()): string {
  const y = now.getUTCFullYear();
  const m = String(now.getUTCMonth() + 1).padStart(2, '0');
  const d = String(now.getUTCDate()).padStart(2, '0');
  const suffix = base32(randomBytes(ORDER_ID_RANDOM_BYTES), ORDER_ID_SUFFIX_LENGTH);
  return `PAY-${y}${m}${d}-${suffix}`;
}

const ORDER_ID_RE = /^PAY-(\d{8})-([0-9A-HJKMNP-TV-Z]{8})$/;

export function isOrderIdFormat(value: string): boolean {
  return ORDER_ID_RE.test(value);
}

/** Order IDs are case-insensitive on input but always stored uppercase. */
export function normalizeOrderId(value: string): string {
  return value.trim().toUpperCase();
}

/**
 * Extracts our order id from a free-form provider reference, tolerating the
 * dashes that UPI apps strip (e.g. "PAY20261022ABCDEFGH").
 */
export function extractOrderId(value: string | null | undefined): string | null {
  if (!value) return null;
  const upper = value.trim().toUpperCase();
  if (isOrderIdFormat(upper)) return upper;
  const compact = upper.replace(/[^A-Z0-9]/g, '');
  const match = /^PAY(\d{8})([0-9A-HJKMNP-TV-Z]{8})$/.exec(compact);
  if (match) {
    const candidate = `PAY-${match[1]}-${match[2]}`;
    if (isOrderIdFormat(candidate)) return candidate;
  }
  return null;
}

export function generateSessionToken(): string {
  return randomToken(48);
}

export function generateUuid(): string {
  return randomUUID();
}

/** Deterministic, non-reversible fingerprint (used for webhook payload hashes). */
export function shortRef(value: string): string {
  return base32(Buffer.from(value), 12);
}

/** Public tracking reference for a customer order (unguessable, read-only). */
export function generatePublicToken(): string {
  return randomToken(24);
}
