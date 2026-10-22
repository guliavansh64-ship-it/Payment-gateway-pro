import { beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../../src/web/app';
import { query } from '../helpers/db';
import { makeMerchant, makeOrder, makeUser } from '../helpers/fixtures';
import { SandboxProvider } from '../../src/providers/sandbox';
import { registerProvider } from '../../src/providers/registry';
import { ProviderError } from '../../src/errors';
import { createOrder } from '../../src/services/orders';
import { verifyOrderWithProvider } from '../../src/services/payments';
import { checkProviderHealth, reconcileProviderOrders } from '../../src/workers/jobs';
import { findOrderByOrderId } from '../../src/repos/orders';
import type { CreatePaymentInput, ProviderHealth, StatusQuery } from '../../src/providers/types';

const app = createApp();

const outage = { create: false, status: false, webhook: false, health: 'OK' as ProviderHealth['status'] };

/**
 * A sandbox adapter whose upstream calls can be made to fail on demand. It
 * models a provider outage without inventing any provider behaviour: every
 * failing path throws a typed, retryable ProviderError.
 */
class FlakySandbox extends SandboxProvider {
  override async createPayment(input: CreatePaymentInput) {
    if (outage.create) throw new ProviderError('sandbox', 'unavailable', 'upstream connect timeout');
    return super.createPayment(input);
  }

  override async getPaymentStatus(input: StatusQuery) {
    if (outage.status) throw new ProviderError('sandbox', 'unavailable', 'status API returned 503');
    return super.getPaymentStatus(input);
  }

  override async verifyWebhook(...args: Parameters<SandboxProvider['verifyWebhook']>) {
    if (outage.webhook) throw new ProviderError('sandbox', 'unavailable', 'signature key service down');
    return super.verifyWebhook(...args);
  }

  override async checkHealth(): Promise<ProviderHealth> {
    return { status: outage.health, detail: 'simulated outage' };
  }
}

function registerFlaky(): void {
  registerProvider(new FlakySandbox());
}

beforeEach(() => {
  outage.create = false;
  outage.status = false;
  outage.webhook = false;
  outage.health = 'OK';
  registerFlaky();
});

describe('provider outage handling', () => {
  it('never leaves a payable order when the provider cannot create a payment', async () => {
    outage.create = true;
    const merchant = await makeMerchant({ ownerId: (await makeUser()).id, defaultProvider: 'sandbox' });

    const { order } = await createOrder(
      { merchantId: merchant.id, amountPaise: 49900, paymentMethod: 'UPI_QR', providerName: 'sandbox' },
      { actorId: null, actorType: 'SYSTEM' },
    );

    expect(order.status).toBe('FAILED');
    expect(order.providerPaymentId).toBeNull();
    const stored = await findOrderByOrderId(order.orderId);
    expect(stored?.status).toBe('FAILED');
    expect(stored?.qrPayload).toBeNull();

    const audit = await query<{ action: string }>('SELECT action FROM audit_logs');
    expect(audit.rows.map((r) => r.action)).toContain('ORDER_PROVIDER_FAILED');
  });

  it('returns 201 but a FAILED order through the merchant API rather than a fake payment link', async () => {
    outage.create = true;
    const user = await makeUser({ role: 'MERCHANT_ADMIN' });
    const merchant = await makeMerchant({ ownerId: user.id, defaultProvider: 'sandbox' });
    const { makeSession } = await import('../helpers/fixtures');
    const session = await makeSession(user);

    const res = await request(app)
      .post('/api/orders')
      .set('Cookie', session.cookie)
      .set('x-csrf-token', session.csrfToken)
      .send({ amount: '499.00', provider: 'sandbox', merchant_id: merchant.id });

    expect(res.status).toBe(201);
    expect(res.body.status).toBe('FAILED');
    // A failed order has no payable instructions, so no customer hand-off link.
    const detail = await request(app)
      .get(`/api/orders/${res.body.order_id}`)
      .set('Cookie', session.cookie);
    expect(detail.status).toBe(200);
    expect(detail.body.status).toBe('FAILED');
    expect(detail.body.status).toBe('FAILED');
    expect(detail.body.paid_at).toBeNull();
    expect(detail.body.verification_status).toBe('UNVERIFIED');
  });

  it('keeps the order untouched when the status API is unreachable', async () => {
    const merchant = await makeMerchant({ ownerId: (await makeUser()).id, defaultProvider: 'sandbox' });
    const order = await makeOrder({ merchantId: merchant.id, provider: 'sandbox' });
    outage.status = true;

    const result = await verifyOrderWithProvider(order, { trigger: 'CUSTOMER_CHECK' });
    expect(result.kind).toBe('UNAVAILABLE');

    const page = await request(app)
      .get(`/pay/${order.orderId}/check?t=${encodeURIComponent(order.publicToken)}`)
      .expect(200);
    expect(page.body.status).toBe('PENDING');

    const after = await findOrderByOrderId(order.orderId);
    expect(after?.status).toBe('PENDING');
    expect(after?.verificationStatus).toBe('UNVERIFIED');
    expect((await query('SELECT 1 FROM payment_transactions')).rowCount).toBe(0);
  });

  it('reports reconciliation errors during an outage without changing status', async () => {
    const merchant = await makeMerchant({ ownerId: (await makeUser()).id, defaultProvider: 'sandbox' });
    const order = await makeOrder({ merchantId: merchant.id, provider: 'sandbox' });
    outage.status = true;

    const report = await reconcileProviderOrders(10);
    expect(report.checked).toBeGreaterThanOrEqual(1);
    expect(report.errors).toBeGreaterThanOrEqual(1);
    expect(report.changed).toBe(0);
    expect((await findOrderByOrderId(order.orderId))?.status).toBe('PENDING');
  });

  it('asks the provider to retry a webhook it could not authenticate', async () => {
    const merchant = await makeMerchant({ ownerId: (await makeUser()).id, defaultProvider: 'sandbox' });
    const order = await makeOrder({ merchantId: merchant.id, provider: 'sandbox' });
    outage.webhook = true;

    const body = JSON.stringify({ event_id: 'sbx_outage', status: 'SUCCESS' });
    const res = await request(app)
      .post('/webhooks/sandbox')
      .set('content-type', 'application/json')
      .set('x-sandbox-signature', 'anything')
      .send(body);

    expect(res.status).toBeGreaterThanOrEqual(500);
    expect(res.status).toBeLessThan(600);
    expect((await findOrderByOrderId(order.orderId))?.status).toBe('PENDING');
    expect((await query('SELECT 1 FROM payment_transactions')).rowCount).toBe(0);
  });

  it('records provider health as DOWN and never treats it as a payment signal', async () => {
    const merchant = await makeMerchant({ ownerId: (await makeUser()).id, defaultProvider: 'sandbox' });
    const order = await makeOrder({ merchantId: merchant.id, provider: 'sandbox' });
    outage.health = 'DOWN';

    const report = await checkProviderHealth();
    expect(report.checked).toBeGreaterThanOrEqual(1);
    expect(report.errors).toBeGreaterThanOrEqual(1);
    expect((await findOrderByOrderId(order.orderId))?.status).toBe('PENDING');
  });
});
