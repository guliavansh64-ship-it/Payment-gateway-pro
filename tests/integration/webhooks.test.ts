import { describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../../src/web/app';
import { query } from '../helpers/db';
import {
  countRows,
  expireOrder,
  latestCase,
  makeMerchant,
  makeOrder,
  makeUser,
  sandboxEvent,
  signedSandboxEvent,
} from '../helpers/fixtures';
import { ingestProviderWebhook } from '../../src/services/payments';
import { findOrderByOrderId } from '../../src/repos/orders';
import type { Order } from '../../src/domain/models';

const app = createApp();

function post(provider: string, body: string, signature?: string): request.Test {
  const req = request(app).post(`/webhooks/${provider}`).set('content-type', 'application/json');
  if (signature !== undefined) req.set('x-sandbox-signature', signature);
  return req.send(body);
}

async function reload(order: Order): Promise<Order> {
  const fresh = await findOrderByOrderId(order.orderId);
  if (!fresh) throw new Error('order disappeared');
  return fresh;
}

describe('provider webhooks', () => {
  it('rejects unknown, disabled and unconfigured providers with distinct codes', async () => {
    const signed = signedSandboxEvent(
      await makeOrder({
        merchantId: (await makeMerchant({ ownerId: (await makeUser()).id, defaultProvider: 'sandbox' })).id,
        provider: 'sandbox',
      }),
    );

    await post('worldpay', signed.body, signed.signature).expect(404);

    // Razorpay is a real adapter but has no credentials in the test environment.
    const razorpayBody = JSON.stringify({ event: 'payment.captured' });
    const razorpay = await post('razorpay', razorpayBody, 'deadbeef');
    expect(razorpay.status).toBe(503);
    expect(razorpay.body.error).toMatch(/not configured/i);
  });

  it('refuses an empty body and an invalid signature', async () => {
    const merchant = await makeMerchant({ ownerId: (await makeUser()).id, defaultProvider: 'sandbox' });
    const order = await makeOrder({ merchantId: merchant.id, provider: 'sandbox' });
    const signed = signedSandboxEvent(order);

    const empty = await request(app)
      .post('/webhooks/sandbox')
      .set('content-type', 'application/json')
      .set('x-sandbox-signature', 'whatever')
      .send('');
    expect(empty.status).toBe(400);

    const tampered = await post('sandbox', signed.body, 'not-a-real-signature');
    expect([400, 401]).toContain(tampered.status);
    expect((await reload(order)).status).toBe('PENDING');
    expect(await countRows('payment_transactions')).toBe(0);
  });

  it('marks an order PAID from a signature-verified provider event', async () => {
    const merchant = await makeMerchant({ ownerId: (await makeUser()).id, defaultProvider: 'sandbox' });
    const order = await makeOrder({ merchantId: merchant.id, provider: 'sandbox' });
    const signed = signedSandboxEvent(order);

    const res = await post('sandbox', signed.body, signed.signature);
    expect(res.status).toBe(200);
    expect(res.body.outcome).toBe('PROCESSED');
    expect(res.headers['cache-control']).toBe('no-store');

    const paid = await reload(order);
    expect(paid.status).toBe('PAID');
    expect(paid.verificationStatus).toBe('VERIFIED');
    expect(paid.verificationSource).toBe('PROVIDER_WEBHOOK');
    expect(paid.paidAmountPaise).toBe(order.amountPaise);
  });

  it('acknowledges a replayed event ID as DUPLICATE without double-crediting', async () => {
    const merchant = await makeMerchant({ ownerId: (await makeUser()).id, defaultProvider: 'sandbox' });
    const order = await makeOrder({ merchantId: merchant.id, provider: 'sandbox' });
    const signed = signedSandboxEvent(order);

    expect((await post('sandbox', signed.body, signed.signature)).status).toBe(200);
    const replay = await post('sandbox', signed.body, signed.signature);
    expect(replay.status).toBe(200);
    expect(replay.body.outcome).toBe('DUPLICATE');

    expect(await countRows('payment_transactions')).toBe(1);
    expect(await countRows('payment_orders')).toBe(1);
    const paid = await reload(order);
    expect(paid.status).toBe('PAID');
    expect(paid.paidAmountPaise).toBe(order.amountPaise);
  });

  it('treats a second, different payment for the same order as duplicate money', async () => {
    const merchant = await makeMerchant({ ownerId: (await makeUser()).id, defaultProvider: 'sandbox' });
    const order = await makeOrder({ merchantId: merchant.id, provider: 'sandbox' });
    const first = signedSandboxEvent(order);
    await post('sandbox', first.body, first.signature).expect(200);

    const second = signedSandboxEvent(order, { reference: 'SBX999888777' });
    const res = await post('sandbox', second.body, second.signature);
    expect(res.status).toBe(200);

    // The order keeps the first payment; the second is on record but uncredited.
    const paid = await reload(order);
    expect(paid.status).toBe('PAID');
    expect(paid.paidAmountPaise).toBe(order.amountPaise);

    const credited = await query<{ count: string }>(
      'SELECT count(*) FROM payment_transactions WHERE order_id = $1 AND credited_to_order = true',
      [order.id],
    );
    expect(credited.rows[0]?.count).toBe('1');
    const total = await query<{ count: string }>(
      'SELECT count(*) FROM payment_transactions WHERE order_id = $1',
      [order.id],
    );
    expect(total.rows[0]?.count).toBe('2');
  });

  it('records an underpayment without marking the order PAID', async () => {
    const merchant = await makeMerchant({ ownerId: (await makeUser()).id, defaultProvider: 'sandbox' });
    const order = await makeOrder({ merchantId: merchant.id, provider: 'sandbox' });
    const short = signedSandboxEvent(order, { amountPaise: order.amountPaise - 5000 });

    const res = await post('sandbox', short.body, short.signature);
    expect(res.status).toBe(200);

    const after = await reload(order);
    expect(after.status).toBe('REVIEW_REQUIRED');
    expect(after.paidAmountPaise).toBeNull();
    const reviewCase = await latestCase();
    expect(reviewCase?.reason).toBe('AMOUNT_MISMATCH');
  });

  it('records an excess payment for review instead of over-crediting', async () => {
    const merchant = await makeMerchant({ ownerId: (await makeUser()).id, defaultProvider: 'sandbox' });
    const order = await makeOrder({ merchantId: merchant.id, provider: 'sandbox' });
    const extra = signedSandboxEvent(order, { amountPaise: order.amountPaise + 10000 });

    expect((await post('sandbox', extra.body, extra.signature)).status).toBe(200);
    const after = await reload(order);
    expect(after.status).toBe('REVIEW_REQUIRED');
    expect(after.paidAmountPaise).toBeNull();
  });

  it('never pays an order from a payment to a different payee', async () => {
    const merchant = await makeMerchant({ ownerId: (await makeUser()).id, defaultProvider: 'sandbox' });
    const order = await makeOrder({ merchantId: merchant.id, provider: 'sandbox' });
    const wrongPayee = signedSandboxEvent(order, { payeeVpa: 'someone.else@okaxis' });

    expect((await post('sandbox', wrongPayee.body, wrongPayee.signature)).status).toBe(200);
    const after = await reload(order);
    expect(after.status).toBe('REVIEW_REQUIRED');
    expect(after.paidAmountPaise).toBeNull();
    const reviewCase = await latestCase();
    expect(reviewCase?.reason).toBe('WRONG_MERCHANT');
  });

  it('records a late payment as LATE_PAYMENT and keeps money acknowledged', async () => {
    const merchant = await makeMerchant({ ownerId: (await makeUser()).id, defaultProvider: 'sandbox' });
    const order = await makeOrder({ merchantId: merchant.id, provider: 'sandbox' });
    await expireOrder(order);

    const signed = signedSandboxEvent(order);
    expect((await post('sandbox', signed.body, signed.signature)).status).toBe(200);

    const after = await reload(order);
    expect(after.status).toBe('LATE_PAYMENT');
    expect(after.paidAmountPaise).toBe(order.amountPaise);
    expect(after.verificationStatus).toBe('VERIFIED');
  });

  it('does not let a stale notification move a final status backwards', async () => {
    const merchant = await makeMerchant({ ownerId: (await makeUser()).id, defaultProvider: 'sandbox' });
    const order = await makeOrder({ merchantId: merchant.id, provider: 'sandbox' });
    const signed = signedSandboxEvent(order);
    await post('sandbox', signed.body, signed.signature).expect(200);
    expect((await reload(order)).status).toBe('PAID');

    // A generic "pending" event for the same payment must not undo PAID.
    const stale = signedSandboxEvent(order, {
      status: 'PENDING',
      reference: signed.payload.provider_transaction_reference as string,
    });
    const res = await post('sandbox', stale.body, stale.signature);
    expect(res.status).toBe(200);
    expect((await reload(order)).status).toBe('PAID');
  });

  it('records a provider-side reversal and moves the order out of PAID', async () => {
    const merchant = await makeMerchant({ ownerId: (await makeUser()).id, defaultProvider: 'sandbox' });
    const order = await makeOrder({ merchantId: merchant.id, provider: 'sandbox' });
    const payment = signedSandboxEvent(order);
    await post('sandbox', payment.body, payment.signature).expect(200);
    expect((await reload(order)).status).toBe('PAID');

    const reversal = signedSandboxEvent(order, {
      status: 'REVERSED',
      reference: payment.payload.provider_transaction_reference as string,
    });
    expect((await post('sandbox', reversal.body, reversal.signature)).status).toBe(200);

    const after = await reload(order);
    expect(after.status).toBe('REVIEW_REQUIRED');
    expect(after.verificationStatus).toBe('REVIEW_REQUIRED');
    const credited = await query<{ count: string }>(
      'SELECT count(*) FROM payment_transactions WHERE order_id = $1 AND credited_to_order = true',
      [order.id],
    );
    expect(credited.rows[0]?.count).toBe('0');
    expect((await latestCase())?.reason).toBe('TRANSACTION_REVERSED');
  });

  it('records money from an unknown order without attaching it to any order', async () => {
    const merchant = await makeMerchant({ ownerId: (await makeUser()).id, defaultProvider: 'sandbox' });
    const order = await makeOrder({ merchantId: merchant.id, provider: 'sandbox' });
    const unknown = signedSandboxEvent(order, {
      orderReference: 'PAY-19990101-ZZZZZZZZ',
      providerPaymentId: null,
      amountPaise: 12345,
    });

    const res = await post('sandbox', unknown.body, unknown.signature);
    expect(res.status).toBe(200);
    // The money is on record but attached to no order: never silently discarded.
    const stored = await query<{ order_id: string | null; verification_status: string }>(
      'SELECT order_id, verification_status FROM payment_transactions',
    );
    expect(stored.rows).toHaveLength(1);
    expect(stored.rows[0]?.order_id).toBeNull();
    // Unmatched provider money is never VERIFIED, whatever review state it lands in.
    expect(stored.rows[0]?.verification_status).not.toBe('VERIFIED');
    expect((await reload(order)).status).toBe('PENDING');
  });

  it('re-processes an event whose first attempt failed instead of dropping it', async () => {
    const merchant = await makeMerchant({ ownerId: (await makeUser()).id, defaultProvider: 'sandbox' });
    const order = await makeOrder({ merchantId: merchant.id, provider: 'sandbox' });
    const signed = signedSandboxEvent(order);

    // Simulate a crash after the inbox row was written but before processing.
    await query(
      `INSERT INTO payment_events (event_id, event_type, source, event_payload_hash, payload, processing_status)
       VALUES ($1, 'payment.success', 'PROVIDER_WEBHOOK', $2, '{}'::jsonb, 'FAILED')`,
      [signed.payload.event_id, 'deadbeef'],
    );

    const res = await post('sandbox', signed.body, signed.signature);
    expect(res.status).toBe(200);
    expect(res.body.outcome).toBe('PROCESSED');
    expect((await reload(order)).status).toBe('PAID');
    expect(await countRows('payment_transactions')).toBe(1);
  });

  it('answers a provider verification probe without leaking secrets', async () => {
    const res = await request(app).get('/webhooks/sandbox').expect(200);
    expect(res.body).toEqual({ provider: 'sandbox', configured: true, mode: 'test' });
    expect(res.text).not.toMatch(/secret|key_/i);
  });

  it('survives a concurrent double delivery with exactly one credit', async () => {
    const merchant = await makeMerchant({ ownerId: (await makeUser()).id, defaultProvider: 'sandbox' });
    const order = await makeOrder({ merchantId: merchant.id, provider: 'sandbox' });
    const event = sandboxEvent(order);

    const results = await Promise.all(
      [0, 1, 2].map(async () => {
        try {
          return await ingestProviderWebhook({
            providerName: 'sandbox',
            rawBody: Buffer.from(JSON.stringify(event)),
            headers: {
              'x-sandbox-signature': signedSandboxEvent(order, {
                eventId: event.event_id as string,
                reference: event.provider_transaction_reference as string,
              }).signature,
            },
          });
        } catch (err) {
          return { httpStatus: 500, outcome: 'ERROR', detail: (err as Error).message };
        }
      }),
    );

    expect(results.filter((r) => r.outcome === 'PROCESSED')).toHaveLength(1);
    expect(await countRows('payment_transactions')).toBe(1);
    const paid = await reload(order);
    expect(paid.status).toBe('PAID');
    expect(paid.paidAmountPaise).toBe(order.amountPaise);
  });
});
