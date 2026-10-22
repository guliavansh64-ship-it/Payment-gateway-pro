import { describe, expect, it } from 'vitest';
import {
  allowedTransitions,
  assertTransition,
  canTransition,
  InvalidTransitionError,
  STATUS_LABELS,
  TERMINAL_STATUSES,
} from '../../src/domain/status';

describe('order state machine', () => {
  it('allows the happy path', () => {
    expect(canTransition('CREATED', 'PENDING')).toBe(true);
    expect(canTransition('PENDING', 'VERIFYING')).toBe(true);
    expect(canTransition('VERIFYING', 'PAID')).toBe(true);
  });

  it('forbids going backwards from a final status', () => {
    expect(canTransition('PAID', 'PENDING')).toBe(false);
    expect(canTransition('PAID', 'CREATED')).toBe(false);
    expect(canTransition('FAILED', 'PENDING')).toBe(false);
    expect(canTransition('REFUNDED', 'PAID')).toBe(false);
    expect(() => assertTransition('PAID', 'EXPIRED')).toThrow(InvalidTransitionError);
  });

  it('models late payment and refund paths', () => {
    expect(canTransition('PENDING', 'LATE_PAYMENT')).toBe(true);
    expect(canTransition('EXPIRED', 'LATE_PAYMENT')).toBe(true);
    expect(canTransition('LATE_PAYMENT', 'REFUND_PENDING')).toBe(true);
    expect(canTransition('PAID', 'REFUND_PENDING')).toBe(true);
    expect(canTransition('REFUND_PENDING', 'REFUNDED')).toBe(true);
    expect(canTransition('PARTIALLY_REFUNDED', 'REFUNDED')).toBe(true);
    expect(canTransition('LATE_PAYMENT', 'PAID')).toBe(true);
  });

  it('rejects self-transitions', () => {
    expect(canTransition('PAID', 'PAID')).toBe(false);
    expect(canTransition('PENDING', 'PENDING')).toBe(false);
  });

  it('only exposes terminal-safe escapes', () => {
    expect(allowedTransitions('REFUNDED')).toEqual(['REVIEW_REQUIRED']);
    expect(allowedTransitions('FAILED')).toEqual(['REVIEW_REQUIRED']);
    expect(TERMINAL_STATUSES).toContain('PAID');
  });

  it('labels every status', () => {
    expect(Object.keys(STATUS_LABELS)).toHaveLength(11);
    expect(STATUS_LABELS.LATE_PAYMENT.toLowerCase()).toContain('late');
  });
});
