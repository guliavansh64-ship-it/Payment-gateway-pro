import { describe, expect, it } from 'vitest';
import {
  decryptSecret,
  encryptSecret,
  hashPassword,
  hmacSha256Hex,
  needsReencryption,
  safeCompare,
  verifyPassword,
} from '../../src/security/crypto';

describe('secret encryption', () => {
  it('round-trips with AAD binding', () => {
    const ciphertext = encryptSecret('1//refresh-token-value', 'gmail:user-1');
    expect(ciphertext).not.toContain('refresh-token-value');
    expect(decryptSecret(ciphertext, 'gmail:user-1')).toBe('1//refresh-token-value');
    expect(() => decryptSecret(ciphertext, 'gmail:user-2')).toThrow();
  });

  it('produces a unique ciphertext per call', () => {
    expect(encryptSecret('same', 'a')).not.toBe(encryptSecret('same', 'a'));
  });

  it('detects rotation needs', () => {
    const old = encryptSecret('x', 'a');
    const rewritten = old.replace(/^v1:/, 'v0:');
    expect(needsReencryption(old)).toBe(false);
    expect(needsReencryption(rewritten)).toBe(true);
  });

  it('rejects tampered ciphertext', () => {
    const ciphertext = encryptSecret('x', 'a');
    const parts = ciphertext.split(':');
    const ct = Buffer.from(parts[3] as string, 'base64');
    ct[0] = (ct[0] as number) ^ 0xff;
    parts[3] = ct.toString('base64');
    expect(() => decryptSecret(parts.join(':'), 'a')).toThrow();
  });
});

describe('passwords', () => {
  it('hashes and verifies with scrypt', async () => {
    const hash = await hashPassword('CorrectHorseBattery9');
    expect(hash.startsWith('scrypt$')).toBe(true);
    expect(await verifyPassword('CorrectHorseBattery9', hash)).toBe(true);
    expect(await verifyPassword('correcthorsebatterY9', hash)).toBe(false);
    expect(await verifyPassword('anything', null)).toBe(false);
  });

  it('enforces strength', async () => {
    await expect(hashPassword('short')).rejects.toThrow();
    await expect(hashPassword('alllowercaseonly')).rejects.toThrow();
  });
});

describe('comparison helpers', () => {
  it('compares strings in constant time', () => {
    expect(safeCompare('abc', 'abc')).toBe(true);
    expect(safeCompare('abc', 'abd')).toBe(false);
    expect(safeCompare('abc', 'abcd')).toBe(false);
  });

  it('computes deterministic HMACs', () => {
    expect(hmacSha256Hex('k', 'v')).toBe(hmacSha256Hex('k', 'v'));
    expect(hmacSha256Hex('k', 'v')).not.toBe(hmacSha256Hex('k', 'v2'));
  });
});
