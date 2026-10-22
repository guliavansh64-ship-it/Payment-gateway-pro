import { describe, expect, it } from 'vitest';
import { buildUpiUri, isValidVpa, parseUpiUri } from '../../src/domain/upi';

describe('UPI intent payloads', () => {
  it('builds a compliant fixed-amount payload', () => {
    const uri = buildUpiUri({
      payeeVpa: 'aarav.traders@okhdfcbank',
      payeeName: 'Aarav Traders',
      amountPaise: 49900,
      transactionRef: 'PAY-20261022-ABCDEFGH',
      transactionNote: 'Order PAY-20261022-ABCDEFGH',
    });
    expect(uri.startsWith('upi://pay?')).toBe(true);
    const parsed = parseUpiUri(uri);
    expect(parsed.payeeVpa).toBe('aarav.traders@okhdfcbank');
    expect(parsed.amountPaise).toBe(49900);
    expect(parsed.currency).toBe('INR');
    expect(parsed.transactionRef).toBe('PAY20261022ABCDEFGH');
  });

  it('rejects invalid payees and sub-rupee amounts', () => {
    expect(() => buildUpiUri({ payeeVpa: 'not-a-vpa', payeeName: 'X', amountPaise: 100 })).toThrow();
    expect(() => buildUpiUri({ payeeVpa: 'a@b', payeeName: '', amountPaise: 100 })).toThrow();
    expect(() => buildUpiUri({ payeeVpa: 'a@b', payeeName: 'X', amountPaise: 99 })).toThrow();
    expect(isValidVpa('aarav.traders@okhdfcbank')).toBe(true);
    expect(isValidVpa('a@b')).toBe(false);
  });

  it('encodes names safely', () => {
    const uri = buildUpiUri({ payeeVpa: 'shop@upi', payeeName: 'A&B Store', amountPaise: 100 });
    expect(uri).not.toContain('&pn=A&B');
    expect(parseUpiUri(uri).payeeName).toBe('A B Store');
  });

  it('omits an amount for an open-amount QR', () => {
    const uri = buildUpiUri({ payeeVpa: 'shop@upi', payeeName: 'Shop', amountPaise: null });
    expect(parseUpiUri(uri).amountPaise).toBeNull();
  });
});
