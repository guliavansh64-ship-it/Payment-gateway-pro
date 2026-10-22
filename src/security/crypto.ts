import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  randomBytes,
  scrypt as scryptCb,
  timingSafeEqual,
} from 'node:crypto';
import { promisify } from 'node:util';
import { getConfig, type EncryptionKey } from '../config';

const scrypt = promisify(scryptCb) as (
  password: string | Buffer,
  salt: string | Buffer,
  keylen: number,
  options: { N: number; r: number; p: number; maxmem: number },
) => Promise<Buffer>;

/**
 * Envelope encryption for OAuth refresh tokens and other server-side secrets.
 *
 * Format: `v<keyVersion>:<ivB64>:<tagB64>:<ciphertextB64>`
 * AES-256-GCM with a per-message random IV and an optional AAD binding the
 * ciphertext to its owner (e.g. the connection id), so a token copied from one
 * row cannot be decrypted into another.
 */

const ALGO = 'aes-256-gcm';
const IV_BYTES = 12;
const TAG_BYTES = 16;

export function encryptSecret(plaintext: string, aad = ''): string {
  const keys = getConfig().encryptionKeys;
  const { version, key } = keys[0] as EncryptionKey; // newest key encrypts
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGO, key, iv, { authTagLength: TAG_BYTES });
  cipher.setAAD(Buffer.from(aad, 'utf8'));
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${version}:${iv.toString('base64')}:${tag.toString('base64')}:${ct.toString('base64')}`;
}

export function decryptSecret(payload: string, aad = ''): string {
  const parts = payload.split(':');
  if (parts.length !== 4) throw new Error('Malformed ciphertext');
  const [version, ivB64, tagB64, ctB64] = parts as [string, string, string, string];
  const entry = getConfig().encryptionKeys.find((k) => k.version === version);
  if (!entry) throw new Error(`Unknown encryption key version: ${version}`);
  const iv = Buffer.from(ivB64, 'base64');
  const tag = Buffer.from(tagB64, 'base64');
  const ct = Buffer.from(ctB64, 'base64');
  if (iv.length !== IV_BYTES || tag.length !== TAG_BYTES) throw new Error('Malformed ciphertext');
  const decipher = createDecipheriv(ALGO, entry.key, iv, { authTagLength: TAG_BYTES });
  decipher.setAAD(Buffer.from(aad, 'utf8'));
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8');
}

/** True when the ciphertext was produced by a key version older than the newest. */
export function needsReencryption(payload: string): boolean {
  const version = payload.split(':')[0];
  return version !== getConfig().encryptionKeys[0]?.version;
}

// ---------------------------------------------------------------------------
// password hashing (scrypt, per-user salt)
// ---------------------------------------------------------------------------
const SCRYPT = { N: 1 << 15, r: 8, p: 1, maxmem: 96 * 1024 * 1024 } as const;
const PASSWORD_PREFIX = 'scrypt';

export async function hashPassword(password: string): Promise<string> {
  assertPasswordStrength(password);
  const salt = randomBytes(16);
  const hash = await scrypt(password.normalize('NFKC'), salt, 64, SCRYPT);
  return `${PASSWORD_PREFIX}$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString('base64')}$${hash.toString('base64')}`;
}

export async function verifyPassword(password: string, stored: string | null): Promise<boolean> {
  if (!stored) {
    // Perform equivalent work to avoid a user-enumeration timing side channel.
    await scrypt(password.normalize('NFKC'), 'dummy-salt-value', 64, SCRYPT).catch(() => null);
    return false;
  }
  const [prefix, n, r, p, saltB64, hashB64] = stored.split('$');
  if (prefix !== PASSWORD_PREFIX || !n || !r || !p || !saltB64 || !hashB64) return false;
  const expected = Buffer.from(hashB64, 'base64');
  const actual = await scrypt(password.normalize('NFKC'), Buffer.from(saltB64, 'base64'), expected.length, {
    N: Number(n),
    r: Number(r),
    p: Number(p),
    maxmem: SCRYPT.maxmem,
  });
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

export function assertPasswordStrength(password: string): void {
  if (password.length < 12) throw new Error('Password must be at least 12 characters');
  if (password.length > 256) throw new Error('Password must be at most 256 characters');
  if (!/[a-z]/.test(password) || !/[A-Z]/.test(password) || !/\d/.test(password)) {
    throw new Error('Password must contain lower case, upper case and a digit');
  }
}

// ---------------------------------------------------------------------------
// hashing / HMAC helpers
// ---------------------------------------------------------------------------
export function sha256(input: string | Buffer): string {
  return createHash('sha256').update(input).digest('hex');
}

export function hmacSha256(secret: string, input: string | Buffer): Buffer {
  return createHmac('sha256', secret).update(input).digest();
}

export function hmacSha256Hex(secret: string, input: string | Buffer): string {
  return createHmac('sha256', secret).update(input).digest('hex');
}

/**
 * Constant-time comparison of two strings of arbitrary length.
 * Compares digests so that length differences do not leak.
 */
export function safeCompare(a: string, b: string): boolean {
  const da = createHash('sha256').update(a).digest();
  const db = createHash('sha256').update(b).digest();
  return timingSafeEqual(da, db) && a.length === b.length;
}

/** Used for session tokens, CSRF tokens and IP addresses: never store raw. */
export function opaqueHash(value: string): string {
  return createHash('sha256').update(getConfig().sessionSecret).update('\0').update(value).digest('hex');
}
