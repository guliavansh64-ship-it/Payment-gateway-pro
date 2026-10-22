import { describe, expect, it } from 'vitest';
import {
  base32,
  generateOrderId,
  generatePublicToken,
  isOrderIdFormat,
  normalizeOrderId,
} from '../../src/domain/ids';

describe('order identifiers', () => {
  it('has the documented, parseable format', () => {
    const id = generateOrderId(new Date('2026-10-22T10:00:00Z'));
    expect(id).toMatch(/^PAY-20261022-[0-9A-HJKMNP-TV-Z]{8}$/);
    expect(isOrderIdFormat(id)).toBe(true);
  });

  it('shows no collisions across 20k ids', () => {
    const ids = new Set<string>();
    for (let i = 0; i < 20_000; i += 1) ids.add(generateOrderId());
    expect(ids.size).toBe(20_000);
  });

  it('does not depend on time alone', () => {
    const day = new Date('2026-10-22T10:00:00Z');
    const first = generateOrderId(day);
    const second = generateOrderId(day);
    expect(first.slice(0, 13)).toBe(second.slice(0, 13));
    expect(first).not.toBe(second);
  });

  it('uses Crockford base32 without ambiguous characters', () => {
    for (let i = 0; i < 200; i += 1) {
      expect(generateOrderId().slice(-8)).not.toMatch(/[ILOU]/);
    }
  });

  it('normalises input case', () => {
    const id = generateOrderId();
    expect(normalizeOrderId(id.toLowerCase())).toBe(id);
  });

  it('rejects forged formats', () => {
    expect(isOrderIdFormat('PAY-2026-ABCDEFGH')).toBe(false);
    expect(isOrderIdFormat('PAY-20261022-ABCDEFGU')).toBe(false); // U is not in the alphabet
    expect(isOrderIdFormat('PAY-20261022-ABCDEFGI')).toBe(false); // I is not in the alphabet
    expect(isOrderIdFormat('ORDER-1')).toBe(false);
  });

  it('produces unguessable public tokens', () => {
    const tokens = new Set<string>();
    for (let i = 0; i < 500; i += 1) tokens.add(generatePublicToken());
    expect(tokens.size).toBe(500);
    expect(generatePublicToken().length).toBeGreaterThanOrEqual(30);
    expect(base32(Buffer.from([0xff, 0xff]), 4)).toHaveLength(4);
  });
});
