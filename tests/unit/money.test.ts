import { describe, expect, it } from 'vitest';
import {
  MoneyError,
  compareAmounts,
  formatPaise,
  formatPaiseInr,
  parseRupeesToPaise,
  sumPaise,
  toPaise,
} from '../../src/domain/money';

describe('money: integer paise arithmetic', () => {
  it('parses rupee decimals exactly (no float drift)', () => {
    expect(parseRupeesToPaise('499')).toBe(49900);
    expect(parseRupeesToPaise('499.1')).toBe(49910);
    expect(parseRupeesToPaise('499.10')).toBe(49910);
    expect(parseRupeesToPaise('0.01')).toBe(1);
    expect(parseRupeesToPaise('1,23,456.78')).toBe(12345678);
    // The classic float trap: 0.1 + 0.2 !== 0.3
    expect(parseRupeesToPaise('0.1') + parseRupeesToPaise('0.2')).toBe(parseRupeesToPaise('0.3'));
  });

  it('rejects malformed and over-precise amounts', () => {
    expect(() => parseRupeesToPaise('499.999')).toThrow(MoneyError);
    expect(() => parseRupeesToPaise('-5')).toThrow(MoneyError);
    expect(() => parseRupeesToPaise('abc')).toThrow(MoneyError);
    expect(() => parseRupeesToPaise('')).toThrow(MoneyError);
  });

  it('formats without floating point', () => {
    expect(formatPaise(49900)).toBe('499.00');
    expect(formatPaise(49910)).toBe('499.10');
    expect(formatPaise(1)).toBe('0.01');
    expect(formatPaise(100000000)).toBe('1000000.00');
    expect(formatPaiseInr(123456789)).toBe('₹12,34,567.89');
    expect(formatPaiseInr(49900)).toBe('₹499.00');
  });

  it('validates paise at boundaries', () => {
    expect(toPaise(1)).toBe(1);
    expect(() => toPaise(0)).toThrow(MoneyError);
    expect(() => toPaise(1.5)).toThrow(MoneyError);
    expect(() => toPaise(Number.MAX_SAFE_INTEGER)).toThrow(MoneyError);
    expect(() => toPaise('100')).toThrow(MoneyError);
  });

  it('compares amounts for under/over payment', () => {
    expect(compareAmounts(100, 100)).toEqual({ kind: 'exact' });
    expect(compareAmounts(100, 90)).toEqual({ kind: 'underpaid', shortfallPaise: 10 });
    expect(compareAmounts(100, 110)).toEqual({ kind: 'overpaid', excessPaise: 10 });
  });

  it('sums safely', () => {
    expect(sumPaise([1, 2, 3])).toBe(6);
    expect(() => sumPaise([1, 1.2])).toThrow(MoneyError);
  });
});
