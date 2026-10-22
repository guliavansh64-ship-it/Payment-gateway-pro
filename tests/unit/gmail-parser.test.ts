import { describe, expect, it } from 'vitest';
import {
  checkSender,
  classifyDirection,
  classifyStatus,
  extractAmountPaise,
  extractBodyText,
  extractUtr,
  extractVpas,
  htmlToText,
  parseTransactionEmail,
} from '../../src/gmail/parser';

const POLICY = { allowedDomains: ['hdfcbank.net', 'alerts.razorpay.com'] };

describe('sender validation', () => {
  it('accepts an allow-listed address', () => {
    expect(checkSender('HDFC Bank <alerts@hdfcbank.net>', POLICY).accepted).toBe(true);
  });

  it('rejects a spoofed display name', () => {
    const result = checkSender('"HDFC Bank" <alerts@hdfc-bank-secure.top>', POLICY);
    expect(result.accepted).toBe(false);
    if (!result.accepted) expect(result.reason).toContain('not on the allow-list');
  });

  it('does not accept lookalike domains', () => {
    expect(checkSender('x@evil-hdfcbank.net', POLICY).accepted).toBe(false);
    expect(checkSender('x@alerts.hdfcbank.net', POLICY).accepted).toBe(true);
  });

  it('rejects everything when no domains are configured', () => {
    expect(checkSender('x@hdfcbank.net', { allowedDomains: [] }).accepted).toBe(false);
  });
});

describe('email body handling', () => {
  it('converts HTML to readable text', () => {
    const text = htmlToText('<style>.x{}</style><p>Rs.&nbsp;1,499.00 credited</p><script>evil()</script>');
    expect(text).toContain('Rs. 1,499.00 credited');
    expect(text).not.toContain('evil');
  });

  it('prefers the plain part of a multipart message', () => {
    const text = extractBodyText({
      parts: [
        { mimeType: 'text/plain', body: { data: Buffer.from('plain version').toString('base64url') } },
        { mimeType: 'text/html', body: { data: Buffer.from('<b>html</b>').toString('base64url') } },
      ],
    });
    expect(text).toBe('plain version');
  });
});

describe('field extraction', () => {
  it('extracts amounts in several formats', () => {
    expect(extractAmountPaise('₹ 1,499.00 has been credited')).toBe(149900);
    expect(extractAmountPaise('INR 499.50 credited')).toBe(49950);
    expect(extractAmountPaise('Amount: 250')).toBe(25000);
    expect(extractAmountPaise('no amount here')).toBeNull();
  });

  it('extracts UTR and RRN references', () => {
    expect(extractUtr('UTR: 412345678901 credited')).toBe('412345678901');
    expect(extractUtr('RRN 999888777666')).toBe('999888777666');
    expect(extractUtr('nothing here')).toBeNull();
  });

  it('finds VPAs and ignores bank support addresses', () => {
    const vpas = extractVpas('from ramesh@okaxis to aarav.traders@okhdfcbank, contact support@hdfcbank.net');
    expect(vpas).toContain('ramesh@okaxis');
    expect(vpas).toContain('aarav.traders@okhdfcbank');
    expect(vpas).not.toContain('support@hdfcbank.net');
  });

  it('classifies direction and status conservatively', () => {
    expect(classifyDirection('Rs 500 credited to your account')).toBe('CREDIT');
    expect(classifyDirection('Rs 500 debited from your account')).toBe('DEBIT');
    expect(classifyDirection('statement attached')).toBe('UNKNOWN');
    expect(classifyStatus('Payment successful')).toBe('SUCCESS');
    expect(classifyStatus('Payment failed')).toBe('FAILED');
    expect(classifyStatus('will be credited shortly')).toBe('PENDING');
    expect(classifyStatus('hello')).toBe('UNKNOWN');
  });
});

describe('full email parsing', () => {
  it('parses a realistic HDFC credit alert', () => {
    const parsed = parseTransactionEmail({
      messageId: 'm1',
      fromHeader: 'HDFC Bank InstaAlerts <alerts@hdfcbank.net>',
      subject: 'Credit alert for your account',
      receivedAt: new Date('2026-10-22T10:00:00Z'),
      text:
        'Rs.499.00 credited to your account ending 1234 on 22-10-26 from RAMESH KUMAR (ramesh@okaxis). ' +
        'UPI transaction ID: 412345678901.',
    });
    expect(parsed.amountPaise).toBe(49900);
    expect(parsed.direction).toBe('CREDIT');
    expect(parsed.status).toBe('SUCCESS');
    expect(parsed.utr).toBe('412345678901');
    expect(parsed.payerVpa).toBe('ramesh@okaxis');
    expect(parsed.confidence).toBeGreaterThan(0.7);
  });

  it('down-weights forwarded alerts', () => {
    const parsed = parseTransactionEmail({
      messageId: 'm2',
      fromHeader: 'Someone <friend@example.com>',
      subject: 'Fwd: payment received',
      receivedAt: new Date(),
      text: 'Rs 499 credited. UTR 412345678901',
    });
    expect(parsed.warnings).toContain('forwarded_message');
    expect(parsed.confidence).toBeLessThan(0.9);
  });

  it('never throws on malformed input', () => {
    const parsed = parseTransactionEmail({
      messageId: 'm3',
      fromHeader: 'not an address',
      subject: '<script>alert(1)</script>',
      receivedAt: new Date(),
      text: '<html><body><table><tr><td>broken',
    });
    expect(parsed.amountPaise).toBeNull();
    expect(parsed.confidence).toBe(0);
    expect(parsed.warnings).toContain('missing_amount');
  });
});
