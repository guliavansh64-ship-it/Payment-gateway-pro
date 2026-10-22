import { describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../../src/web/app';
import { query } from '../helpers/db';
import {
  countRows,
  insertSandboxPayment,
  makeMerchant,
  makeOrder,
  makeUser,
} from '../helpers/fixtures';
import { verifyOrderWithProvider } from '../../src/services/payments';
import { findOrderByOrderId } from '../../src/repos/orders';
import type { Order } from '../../src/domain/models';

const app = createApp();

async function reload(order: Order): Promise<Order> {
  const fresh = await findOrderByOrderId(order.orderId);
  if (!fresh) throw new Error('order disappeared');
  return fresh;
}

describe('sandbox status polling', () => {
  it('reports PENDING and changes nothing when the provider has no payment', async () => {
    const merchant = await makeMerchant({ ownerId: (await makeUser()).id, defaultProvider: 'sandbox' });
    const order = await makeOrder({ merchantId: merchant.id, provider: 'sandbox' });

    const res = await request(app)
      .get(`/pay/${order.orderId}/check?t=${encodeURIComponent(order.publicToken)}`)
      .expect(200);
    expect(res.body.status).toBe('PENDING');

    const after = await reload(order);
    expect(after.status).toBe('PENDING');
    expect(after.verificationStatus).toBe('UNVERIFIED');
    expect(await countRows('payment_transactions')).toBe(0);
  });

  it('pays an order only after the provider reports a successful payment', async () => {
    const merchant = await makeMerchant({ ownerId: (await makeUser()).id, defaultProvider: 'sandbox' });
    const order = await makeOrder({ merchantId: merchant.id, provider: 'sandbox' });

    await insertSandboxPayment({
      providerPaymentId: order.providerPaymentId as string,
      orderReference: order.orderId,
      status: 'SUCCESS',
      amountPaise: order.amountPaise,
      reference: 'SBX555000111',
      payeeVpa: order.upiPayeeVpa,
    });

    const res = await request(app)
      .get(`/pay/${order.orderId}/check?t=${encodeURIComponent(order.publicToken)}`)
      .expect(200);
    expect(res.body.status).toBe('PAID');

    const after = await reload(order);
    expect(after.verificationSource).toBe('PROVIDER_API');
    expect(after.paidAmountPaise).toBe(order.amountPaise);
  });

  it('does not pay an order from a provider FAILED status', async () => {
    const merchant = await makeMerchant({ ownerId: (await makeUser()).id, defaultProvider: 'sandbox' });
    const order = await makeOrder({ merchantId: merchant.id, provider: 'sandbox' });
    await insertSandboxPayment({
      providerPaymentId: order.providerPaymentId as string,
      orderReference: order.orderId,
      status: 'FAILED',
      amountPaise: order.amountPaise,
      reference: 'SBX555000222',
      payeeVpa: order.upiPayeeVpa,
    });

    await verifyOrderWithProvider(order, { trigger: 'CUSTOMER_CHECK' });
    const after = await reload(order);
    expect(after.status).not.toBe('PAID');
    expect(after.verificationStatus).not.toBe('VERIFIED');
  });

  it('is idempotent: repeated status polls credit the payment once', async () => {
    const merchant = await makeMerchant({ ownerId: (await makeUser()).id, defaultProvider: 'sandbox' });
    const order = await makeOrder({ merchantId: merchant.id, provider: 'sandbox' });
    await insertSandboxPayment({
      providerPaymentId: order.providerPaymentId as string,
      orderReference: order.orderId,
      status: 'SUCCESS',
      amountPaise: order.amountPaise,
      reference: 'SBX555000333',
      payeeVpa: order.upiPayeeVpa,
    });

    for (let i = 0; i < 3; i += 1) {
      await verifyOrderWithProvider(await reload(order), { trigger: 'CUSTOMER_CHECK' });
    }

    const credited = await query<{ count: string }>(
      'SELECT count(*) FROM payment_transactions WHERE order_id = $1 AND credited_to_order = true',
      [order.id],
    );
    expect(credited.rows[0]?.count).toBe('1');
    expect((await reload(order)).status).toBe('PAID');
  });

  it('marks a provider-reported reversal for review on the next poll', async () => {
    const merchant = await makeMerchant({ ownerId: (await makeUser()).id, defaultProvider: 'sandbox' });
    const order = await makeOrder({ merchantId: merchant.id, provider: 'sandbox' });
    await insertSandboxPayment({
      providerPaymentId: order.providerPaymentId as string,
      orderReference: order.orderId,
      status: 'SUCCESS',
      amountPaise: order.amountPaise,
      reference: 'SBX555000444',
      payeeVpa: order.upiPayeeVpa,
    });
    await verifyOrderWithProvider(order, { trigger: 'CUSTOMER_CHECK' });
    expect((await reload(order)).status).toBe('PAID');

    await query(`UPDATE sandbox_payments SET status = 'REVERSED' WHERE provider_payment_id = $1`, [
      order.providerPaymentId,
    ]);
    await verifyOrderWithProvider(await reload(order), { trigger: 'RECONCILIATION' });

    const after = await reload(order);
    expect(after.status).toBe('REVIEW_REQUIRED');
    const credited = await query<{ count: string }>(
      'SELECT count(*) FROM payment_transactions WHERE order_id = $1 AND credited_to_order = true',
      [order.id],
    );
    expect(credited.rows[0]?.count).toBe('0');
  });

  it('does not let the browser claim success through the sandbox simulator', async () => {
    const merchant = await makeMerchant({ ownerId: (await makeUser()).id, defaultProvider: 'sandbox' });
    const order = await makeOrder({ merchantId: merchant.id, provider: 'sandbox' });

    // No token: refused.
    await request(app).post('/sandbox/simulate').type('form').send({ order_id: order.orderId }).expect(404);

    // With the order token the simulator delivers a signed provider event, so the
    // event — not the form — is what changes the order.
    const res = await request(app)
      .post('/sandbox/simulate')
      .type('form')
      .send({ order_id: order.orderId, t: order.publicToken, scenario: 'success' });
    expect(res.status).toBe(302);

    const after = await reload(order);
    expect(after.status).toBe('PAID');
    expect(after.verificationSource).toBe('PROVIDER_WEBHOOK');
    expect(await countRows('payment_events')).toBe(1);
  });
});
