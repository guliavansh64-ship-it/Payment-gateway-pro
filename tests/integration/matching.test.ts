import { describe, expect, it } from 'vitest';
import { query } from '../helpers/db';
import { makeMerchant, makeOrder, makeUser, signedSandboxEvent } from '../helpers/fixtures';
import { ingestProviderWebhook } from '../../src/services/payments';

async function deliver(
  orderIdForSignature: Awaited<ReturnType<typeof makeOrder>>,
  overrides: Parameters<typeof signedSandboxEvent>[1],
) {
  const signed = signedSandboxEvent(orderIdForSignature, overrides);
  return ingestProviderWebhook({
    providerName: 'sandbox',
    rawBody: Buffer.from(signed.body),
    headers: { 'x-sandbox-signature': signed.signature },
  });
}

async function setupMerchant() {
  const user = await makeUser();
  return makeMerchant({ ownerId: user.id });
}

describe('matching with identical amounts', () => {
  it('uses the order reference carried by the provider to pick the right order', async () => {
    const merchant = await setupMerchant();
    const first = await makeOrder({ merchantId: merchant.id, amountPaise: 49900 });
    const second = await makeOrder({ merchantId: merchant.id, amountPaise: 49900 });

    const result = await deliver(first, { reference: '400000000001' });
    expect(result.outcome).toBe('PROCESSED');

    const rows = await query<{ order_id: string; status: string }>(
      'SELECT order_id, status FROM payment_orders ORDER BY created_at',
    );
    expect(rows.rows.find((r) => r.order_id === first.orderId)?.status).toBe('PAID');
    expect(rows.rows.find((r) => r.order_id === second.orderId)?.status).toBe('PENDING');
  });

  it('routes an unidentifiable payment between identical orders to review', async () => {
    const merchant = await setupMerchant();
    const first = await makeOrder({ merchantId: merchant.id, amountPaise: 49900 });
    const second = await makeOrder({ merchantId: merchant.id, amountPaise: 49900 });

    const result = await deliver(first, {
      orderReference: null,
      providerPaymentId: null,
      reference: '400000000002',
    });
    expect(result.outcome).toBe('REVIEW_REQUIRED');

    const rows = await query<{ status: string }>('SELECT status FROM payment_orders');
    expect(rows.rows.map((r) => r.status)).toEqual(['PENDING', 'PENDING']);
    // Nothing is credited, and both candidate orders are recorded on the case.
    const tx = await query<{ order_id: string | null; credited_to_order: boolean; verification_status: string }>(
      'SELECT order_id, credited_to_order, verification_status FROM payment_transactions',
    );
    expect(tx.rows[0]?.order_id).toBeNull();
    expect(tx.rows[0]?.credited_to_order).toBe(false);
    expect(tx.rows[0]?.verification_status).toBe('REVIEW_REQUIRED');

    const cases = await query<{ reason: string; possible_order_ids: string[] }>(
      'SELECT reason, possible_order_ids FROM reconciliation_cases',
    );
    expect(cases.rows[0]?.reason).toBe('AMBIGUOUS_MATCH');
    expect(cases.rows[0]?.possible_order_ids).toHaveLength(2);
  });

  it('accepts the order id embedded in a UPI transaction reference, dashes removed', async () => {
    const merchant = await setupMerchant();
    const order = await makeOrder({ merchantId: merchant.id, amountPaise: 72000 });
    const embedded = order.orderId.replace(/-/g, '').toLowerCase();

    const result = await deliver(order, {
      orderReference: null,
      providerPaymentId: null,
      reference: embedded,
    });
    expect(result.outcome).toBe('PROCESSED');

    const row = await query<{ status: string; verification_source: string }>(
      'SELECT status, verification_source FROM payment_orders WHERE order_id = $1',
      [order.orderId],
    );
    expect(row.rows[0]?.status).toBe('PAID');
    expect(row.rows[0]?.verification_source).toBe('PROVIDER_WEBHOOK');
  });

  it('does not match a payment outside the time window', async () => {
    const merchant = await setupMerchant();
    const old = await makeOrder({ merchantId: merchant.id, amountPaise: 30000 });
    await query(`UPDATE payment_orders SET created_at = now() - interval '6 hours' WHERE id = $1`, [old.id]);

    const result = await deliver(old, {
      orderReference: null,
      providerPaymentId: null,
      reference: '400000000003',
    });
    expect(result.outcome).toBe('REVIEW_REQUIRED');

    const status = await query<{ status: string }>('SELECT status FROM payment_orders');
    expect(status.rows[0]?.status).toBe('PENDING');
    // The order is listed as a possible match so a human can still act on it.
    const cases = await query<{ reason: string }>('SELECT reason FROM reconciliation_cases');
    expect(cases.rows[0]?.reason).toBe('MISSING_REFERENCE');
  });

  it('ignores a payment for a different merchant account', async () => {
    const merchantA = await setupMerchant();
    const merchantB = await setupMerchant();
    const orderA = await makeOrder({ merchantId: merchantA.id, amountPaise: 15000 });
    await makeOrder({ merchantId: merchantB.id, amountPaise: 15000 });

    const result = await deliver(orderA, {
      orderReference: null,
      providerPaymentId: null,
      reference: '400000000004',
      payeeVpa: 'someone.else@okicici',
    });
    // Two merchants now exist, so the candidate has no unambiguous merchant and
    // is refused rather than guessed.
    expect(['IGNORED', 'REVIEW_REQUIRED']).toContain(result.outcome);
    const paid = await query(`SELECT count(*)::int AS n FROM payment_orders WHERE status = 'PAID'`);
    expect(paid.rows[0]?.n).toBe(0);
  });
});
