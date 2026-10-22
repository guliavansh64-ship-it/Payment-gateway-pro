import { describe, expect, it } from 'vitest';
import { query } from '../helpers/db';
import {
  expireOrder,
  makeMerchant,
  makeOrder,
  makeUser,
} from '../helpers/fixtures';
import { createOrder } from '../../src/services/orders';
import { sweepExpiredOrders } from '../../src/workers/jobs';
import { registerProvider } from '../../src/providers/registry';
import type { PaymentProvider } from '../../src/providers/types';
import { ProviderError } from '../../src/errors';
import { getStatusHistory } from '../../src/repos/orders';

function brokenProvider(): PaymentProvider {
  return {
    name: 'broken_provider',
    displayName: 'Broken Provider',
    capabilities: {
      dynamicQr: true,
      paymentRequest: true,
      statusApi: false,
      webhooks: false,
      refunds: false,
      reconciliation: false,
      simulated: false,
    },
    isConfigured: () => true,
    async createPayment() {
      throw new ProviderError('broken_provider', 'unavailable', 'Provider is down');
    },
    async getPaymentStatus() {
      throw new ProviderError('broken_provider', 'unsupported', 'Not supported');
    },
    async verifyWebhook() {
      throw new ProviderError('broken_provider', 'unsupported', 'Not supported');
    },
    parseWebhook() {
      throw new ProviderError('broken_provider', 'unsupported', 'Not supported');
    },
    async refund() {
      throw new ProviderError('broken_provider', 'unsupported', 'Not supported');
    },
    async checkHealth() {
      return { status: 'DOWN' as const, checkedAt: new Date(), detail: 'down' };
    },
  };
}

describe('order creation', () => {
  it('stores an exact integer-paise amount and a payable instruction', async () => {
    const user = await makeUser();
    const merchant = await makeMerchant({ ownerId: user.id });
    const { order } = await createOrder(
      {
        merchantId: merchant.id,
        amountRupees: '499.10',
        paymentMethod: 'UPI_QR',
        providerName: 'sandbox',
      },
      { actorId: null, actorType: 'SYSTEM' },
    );

    expect(order.amountPaise).toBe(49910);
    expect(order.status).toBe('PENDING');
    expect(order.orderId).toMatch(/^PAY-\d{8}-[0-9A-Z]{8}$/);
    expect(order.publicToken.length).toBeGreaterThanOrEqual(30);
    expect(order.providerPaymentId).toBeTruthy();
    expect(order.qrPayload?.startsWith('upi://pay')).toBe(true);

    const stored = await query<{ amount_paise: string }>(
      'SELECT amount_paise FROM payment_orders WHERE order_id = $1',
      [order.orderId],
    );
    expect(stored.rows[0]?.amount_paise).toBe('49910');

    const history = await getStatusHistory(order.id);
    expect(history.map((h) => h.toStatus)).toEqual(['CREATED', 'PENDING']);
    const audit = await query<{ action: string }>('SELECT action FROM audit_logs ORDER BY id');
    expect(audit.rows.map((a) => a.action)).toContain('ORDER_CREATED');
  });

  it('creates a different order id every time', async () => {
    const user = await makeUser();
    const merchant = await makeMerchant({ ownerId: user.id });
    const ids = new Set<string>();
    for (let i = 0; i < 15; i += 1) {
      const order = await makeOrder({ merchantId: merchant.id, amountPaise: 1000 + i });
      ids.add(order.orderId);
    }
    expect(ids.size).toBe(15);
  });

  it('rejects invalid and out-of-range amounts', async () => {
    const user = await makeUser();
    const merchant = await makeMerchant({ ownerId: user.id });
    await expect(
      createOrder({ merchantId: merchant.id, amountRupees: '0', paymentMethod: 'UPI_QR', providerName: 'sandbox' }),
    ).rejects.toThrow();
    await expect(
      createOrder({ merchantId: merchant.id, amountRupees: 'abc', paymentMethod: 'UPI_QR', providerName: 'sandbox' }),
    ).rejects.toThrow();
    await expect(
      createOrder({
        merchantId: merchant.id,
        amountPaise: 10_000_001,
        paymentMethod: 'UPI_QR',
        providerName: 'sandbox',
      }),
    ).rejects.toThrow(/maximum/i);
  });

  it('refuses to collect for an inactive merchant', async () => {
    const user = await makeUser();
    const merchant = await makeMerchant({ ownerId: user.id, accountStatus: 'SUSPENDED' });
    await expect(
      createOrder({ merchantId: merchant.id, amountPaise: 1000, paymentMethod: 'UPI_QR', providerName: 'sandbox' }),
    ).rejects.toThrow(/not active/i);
  });

  it('marks the order FAILED (not PENDING) when the provider request fails', async () => {
    registerProvider(brokenProvider());
    const user = await makeUser();
    const merchant = await makeMerchant({ ownerId: user.id, defaultProvider: 'broken_provider' });
    const { order } = await createOrder({
      merchantId: merchant.id,
      amountPaise: 49900,
      paymentMethod: 'UPI_QR',
      providerName: 'broken_provider',
    });

    expect(order.status).toBe('FAILED');
    expect(order.qrPayload).toBeNull();
    const stored = await query<{ status: string; metadata: Record<string, unknown> }>(
      'SELECT status, metadata FROM payment_orders WHERE order_id = $1',
      [order.orderId],
    );
    expect(stored.rows[0]?.status).toBe('FAILED');
    expect(stored.rows[0]?.metadata.provider_error).toContain('Provider is down');
  });

  it('requires a verified UPI ID for direct UPI collection', async () => {
    const user = await makeUser();
    const merchant = await makeMerchant({ ownerId: user.id, upi: null });
    await expect(
      createOrder({ merchantId: merchant.id, amountPaise: 5000, paymentMethod: 'UPI_QR', providerName: 'manual_upi' }),
    ).rejects.toThrow(/verified UPI ID/i);
  });
});

describe('order immutability and state guards', () => {
  it('cannot change the amount or merchant, even with raw SQL', async () => {
    const user = await makeUser();
    const merchant = await makeMerchant({ ownerId: user.id });
    const order = await makeOrder({ merchantId: merchant.id, amountPaise: 25000 });

    await expect(
      query('UPDATE payment_orders SET amount_paise = 100 WHERE id = $1', [order.id]),
    ).rejects.toThrow(/immutable/);
    await expect(
      query('UPDATE payment_orders SET merchant_id = gen_random_uuid() WHERE id = $1', [order.id]),
    ).rejects.toThrow(/immutable/);
    await expect(
      query('UPDATE payment_orders SET order_id = $2 WHERE id = $1', [order.id, 'PAY-20260101-AAAAAAAA']),
    ).rejects.toThrow(/immutable/);
  });

  it('cannot jump to an illegal status, even with raw SQL', async () => {
    const user = await makeUser();
    const merchant = await makeMerchant({ ownerId: user.id });
    const order = await makeOrder({ merchantId: merchant.id });

    await expect(
      query('UPDATE payment_orders SET status = $2 WHERE id = $1', [order.id, 'REFUNDED']),
    ).rejects.toThrow(/illegal order transition/);
    await expect(
      query('UPDATE payment_orders SET status = $2 WHERE id = $1', [order.id, 'CREATED']),
    ).rejects.toThrow(/illegal order transition/);
  });

  it('keeps audit records append-only', async () => {
    const user = await makeUser();
    const merchant = await makeMerchant({ ownerId: user.id });
    await makeOrder({ merchantId: merchant.id });
    await expect(query('UPDATE audit_logs SET action = $1', ['TAMPERED'])).rejects.toThrow(/immutable/);
    await expect(query('DELETE FROM audit_logs')).rejects.toThrow(/retention job/);
  });
});

describe('expiry', () => {
  it('expires unpaid orders and records why', async () => {
    const user = await makeUser();
    const merchant = await makeMerchant({ ownerId: user.id });
    const order = await makeOrder({ merchantId: merchant.id });
    await expireOrder(order);

    const report = await sweepExpiredOrders();
    expect(report.changed).toBe(1);

    const stored = await query<{ status: string }>('SELECT status FROM payment_orders WHERE id = $1', [order.id]);
    expect(stored.rows[0]?.status).toBe('EXPIRED');

    const history = await getStatusHistory(order.id);
    expect(history.at(-1)?.reasonCode).toBe('PAYMENT_WINDOW_ELAPSED');
  });

  it('is idempotent', async () => {
    const user = await makeUser();
    const merchant = await makeMerchant({ ownerId: user.id });
    const order = await makeOrder({ merchantId: merchant.id });
    await expireOrder(order);
    await sweepExpiredOrders();
    const second = await sweepExpiredOrders();
    expect(second.changed).toBe(0);
    expect((await query('SELECT status FROM payment_orders WHERE id = $1', [order.id])).rows[0]?.status).toBe('EXPIRED');
  });

  it('never expires an order that already holds a payment', async () => {
    const user = await makeUser();
    const merchant = await makeMerchant({ ownerId: user.id });
    const order = await makeOrder({ merchantId: merchant.id });
    await query(`UPDATE payment_orders SET status = 'PAID', paid_at = now(), paid_amount_paise = amount_paise WHERE id = $1`, [
      order.id,
    ]);
    await expireOrder(order);
    await sweepExpiredOrders();
    expect((await query('SELECT status FROM payment_orders WHERE id = $1', [order.id])).rows[0]?.status).toBe('PAID');
  });
});
