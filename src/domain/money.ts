import { z } from 'zod';

/**
 * All monetary arithmetic is integer paise. Floats are never used.
 *
 * UPI/BHIM quotes amounts in rupees but processes paise. A decimal string is
 * the only accepted external representation so that "499.10" cannot be
 * silently rounded by IEEE-754.
 */

export const MAX_PAISE = 1_000_000_000_00; // ₹100 crore hard ceiling
export const MIN_PAISE = 1; // ₹0.01

const DECIMAL_RE = /^(\d{1,12})(?:\.(\d{1,2}))?$/;

/** Parses a rupee decimal string ("499", "499.9", "499.10") into paise. */
export function parseRupeesToPaise(input: string | number): number {
  if (typeof input === 'number') {
    if (!Number.isFinite(input)) throw new MoneyError('Amount is not a finite number');
    // Only accept numbers that are exactly representable at paise precision.
    return parseRupeesToPaise(input.toFixed(2));
  }
  const raw = input.trim().replace(/,/g, '');
  const match = DECIMAL_RE.exec(raw);
  if (!match) throw new MoneyError(`Invalid rupee amount: ${input}`);
  const rupees = Number(match[1]);
  const paisePart = match[2] ?? '';
  const paise = paisePart.length === 0 ? 0 : Number(paisePart.padEnd(2, '0'));
  const total = rupees * 100 + paise;
  if (!Number.isSafeInteger(total)) throw new MoneyError('Amount is out of range');
  return total;
}

/** Formats paise as an exact rupee decimal string with two decimals. */
export function formatPaise(paise: number): string {
  assertIntegerPaise(paise);
  const sign = paise < 0 ? '-' : '';
  const abs = Math.abs(paise);
  const rupees = Math.floor(abs / 100);
  const frac = abs % 100;
  return `${sign}${rupees}.${String(frac).padStart(2, '0')}`;
}

/** Formats paise for rendering with lakh/crore grouping used in India. */
export function formatPaiseInr(paise: number): string {
  assertIntegerPaise(paise);
  const negative = paise < 0;
  const abs = Math.abs(paise);
  const rupees = String(Math.floor(abs / 100));
  const formatted = rupees.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  // Indian grouping: last three digits, then groups of two.
  const indian = (() => {
    if (rupees.length <= 3) return formatted;
    const last3 = rupees.slice(-3);
    const rest = rupees.slice(0, -3);
    return `${rest.replace(/\B(?=(\d{2})+(?!\d))/g, ',')},${last3}`;
  })();
  const frac = String(abs % 100).padStart(2, '0');
  return `${negative ? '-' : ''}₹${indian}.${frac}`;
}

export function assertIntegerPaise(value: number): void {
  if (!Number.isSafeInteger(value)) {
    throw new MoneyError(`Paise value must be a safe integer, received: ${value}`);
  }
}

const paiseSchema = z
  .number()
  .int('Amount must be an integer number of paise')
  .min(MIN_PAISE, 'Amount must be at least 1 paise')
  .max(MAX_PAISE, 'Amount exceeds the configured maximum');

/** Parses and validates integer paise coming from any boundary (DB, provider, user). */
export function toPaise(value: unknown): number {
  const parsed = paiseSchema.safeParse(value);
  if (!parsed.success) throw new MoneyError(parsed.error.issues[0]?.message ?? 'Invalid amount');
  return parsed.data;
}

export function sumPaise(values: number[]): number {
  let total = 0;
  for (const v of values) {
    assertIntegerPaise(v);
    total += v;
    if (!Number.isSafeInteger(total)) throw new MoneyError('Sum overflow');
  }
  return total;
}

/** Compares the paid amount against the expected amount. */
export type AmountComparison =
  | { kind: 'exact' }
  | { kind: 'underpaid'; shortfallPaise: number }
  | { kind: 'overpaid'; excessPaise: number };

export function compareAmounts(expectedPaise: number, actualPaise: number): AmountComparison {
  assertIntegerPaise(expectedPaise);
  assertIntegerPaise(actualPaise);
  if (actualPaise === expectedPaise) return { kind: 'exact' };
  if (actualPaise < expectedPaise) {
    return { kind: 'underpaid', shortfallPaise: expectedPaise - actualPaise };
  }
  return { kind: 'overpaid', excessPaise: actualPaise - expectedPaise };
}

export function isSupportedCurrency(currency: string): boolean {
  return currency.toUpperCase() === 'INR';
}

export class MoneyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MoneyError';
  }
}
