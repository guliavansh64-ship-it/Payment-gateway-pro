import { describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../../src/web/app';
import { query } from '../helpers/db';
import {
  TEST_PASSWORD,
  makeMerchant,
  makeOrder,
  makeSession,
  makeUser,
  signedSandboxEvent,
} from '../helpers/fixtures';
import { createOrder } from '../../src/services/orders';

const app = createApp();

type Agent = ReturnType<typeof request.agent>;

async function loginAgent(email: string): Promise<{ agent: Agent; csrf: string }> {
  const agent = request.agent(app);
  const page = await agent.get('/login');
  const csrf = /name="_csrf" value="([^"]*)"/.exec(page.text)?.[1] ?? '';
  const res = await agent
    .post('/login')
    .type('form')
    .send({ _csrf: csrf, email, password: TEST_PASSWORD, next: '/dashboard' });
  if (res.status !== 302) {
    console.log('LOGIN FAILED', res.status, res.text.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').slice(0, 300));
  }
  expect(res.status).toBe(302);
  expect(res.headers.location).toBe('/dashboard');
  const cookieHeader = res.headers['set-cookie'] as unknown as string[];
  expect(cookieHeader.some((c) => c.startsWith('sid=') && c.includes('HttpOnly'))).toBe(true);
  // The session-bound CSRF token is rendered into the page; the pre-auth token
  // used above is only valid for the login form itself.
  const dash = await agent.get('/dashboard');
  const sessionCsrf = /name="csrf-token" content="([^"]*)"/.exec(dash.text)?.[1] ?? '';
  return { agent, csrf: sessionCsrf };
}

describe('authentication', () => {
  it('serves the login page and rejects a login without the pre-auth token', async () => {
    const agent = request.agent(app);
    const page = await agent.get('/login');
    expect(page.status).toBe(200);
    expect(page.text).toContain('name="_csrf"');

    const res = await agent.post('/login').type('form').send({ email: 'x@y.test', password: 'whatever' });
    expect(res.status).toBe(403);
  });

  it('signs in, sets an HttpOnly session, and signs out', async () => {
    const user = await makeUser({ role: 'MERCHANT_ADMIN' });
    await makeMerchant({ ownerId: user.id });
    const { agent, csrf } = await loginAgent(user.email);

    const dash = await agent.get('/dashboard');
    expect(dash.status).toBe(200);
    expect(dash.text).toContain('Dashboard');

    const out = await agent.post('/logout').type('form').send({ _csrf: csrf });
    expect(out.status).toBe(302);
    const after = await agent.get('/dashboard');
    expect(after.status).toBe(302);
    expect(after.headers.location).toContain('/login');
  });

  it('rejects a wrong password without revealing whether the account exists', async () => {
    const user = await makeUser({ role: 'MERCHANT_ADMIN' });
    const agent = request.agent(app);
    const page = await agent.get('/login');
    const csrf = /name="_csrf" value="([^"]*)"/.exec(page.text)?.[1] ?? '';
    const res = await agent
      .post('/login')
      .type('form')
      .send({ _csrf: csrf, email: user.email, password: 'WrongPassword123' });
    expect(res.status).toBe(401);
    expect(res.text).toContain('Email or password is incorrect');
  });

  it('redirects anonymous users to login and forbids cross-merchant access', async () => {
    const anon = await request(app).get('/dashboard');
    expect(anon.status).toBe(302);

    const ownerA = await makeUser();
    const ownerB = await makeUser();
    const merchantA = await makeMerchant({ ownerId: ownerA.id });
    const merchantB = await makeMerchant({ ownerId: ownerB.id });
    const orderB = await makeOrder({ merchantId: merchantB.id });

    const { agent } = await loginAgent(ownerA.email);
    const forbidden = await agent.get(`/dashboard/orders/${orderB.orderId}`);
    expect(forbidden.status).toBe(403);
    expect(forbidden.text).toContain('another merchant');

    const list = await agent.get('/dashboard/orders');
    expect(list.text).not.toContain(orderB.orderId);
    expect(merchantA.id).toBeTruthy();
  });

  it('requires a CSRF token for state-changing requests', async () => {
    const user = await makeUser({ role: 'ADMIN' });
    const { agent } = await loginAgent(user.email);
    const owner = await makeUser();
    const merchant = await makeMerchant({ ownerId: owner.id });
    const order = await makeOrder({ merchantId: merchant.id });

    const noToken = await agent.post(`/dashboard/orders/${order.orderId}/verify`).type('form').send({});
    expect(noToken.status).toBe(403);
    expect(noToken.text).toContain('session token expired');
  });

  it('blocks merchants from admin pages', async () => {
    const user = await makeUser({ role: 'MERCHANT_ADMIN' });
    await makeMerchant({ ownerId: user.id });
    const { agent } = await loginAgent(user.email);
    const res = await agent.get('/admin');
    expect(res.status).toBe(403);
  });
});

describe('customer payment page', () => {
  it('creates an order and shows a payment page with a QR', async () => {
    const owner = await makeUser();
    await makeMerchant({ ownerId: owner.id });

    const agent = request.agent(app);
    const created = await agent.post('/pay/new').type('form').send({ amount: '249.50', description: 'Test' });
    expect(created.status).toBe(302);
    const location = created.headers.location as string;
    expect(location).toMatch(/^\/pay\/PAY-\d{8}-[0-9A-Z]{8}\?t=/);

    const page = await agent.get(location);
    expect(page.status).toBe(200);
    expect(page.text).toContain('₹249.50');
    expect(page.text).toContain('/qr.png?t=');
    expect(page.text).toContain('Check payment status');
    // The UPI intent link must be escaped exactly once by EJS; double escaping
    // opens a URI with a literal "&amp;" in its parameters.
    const upiHref = /href="(upi:\/\/pay\?[^"]*)"/.exec(page.text)?.[1] ?? '';
    expect(upiHref).toContain('&amp;');
    expect(upiHref).not.toContain('&amp;amp;');
    // It never asks for a credential it must not collect.
    expect(page.text.toLowerCase()).not.toContain('enter your upi pin');
    expect(page.text).toContain('never ask for your UPI PIN');

    const orderId = /PAY-\d{8}-[0-9A-Z]{8}/.exec(location)![0];
    const token = location.split('t=')[1];
    const qr = await agent.get(`/pay/${orderId}/qr.png?t=${token}`);
    expect(qr.status).toBe(200);
    expect(qr.headers['content-type']).toBe('image/png');
  });

  it('refuses to show an order without the correct token', async () => {
    const owner = await makeUser();
    const merchant = await makeMerchant({ ownerId: owner.id });
    const order = await makeOrder({ merchantId: merchant.id });

    expect((await request(app).get(`/pay/${order.orderId}`)).status).toBe(404);
    expect((await request(app).get(`/pay/${order.orderId}?t=wrong-token`)).status).toBe(404);
    expect((await request(app).get(`/pay/${order.orderId}/status?t=wrong-token`)).status).toBe(404);
  });

  it('never lets the browser self-declare success', async () => {
    const owner = await makeUser();
    const merchant = await makeMerchant({ ownerId: owner.id });
    const order = await makeOrder({ merchantId: merchant.id });

    const status = await request(app).get(`/pay/${order.orderId}/status?t=${order.publicToken}`);
    expect(status.body.status).toBe('PENDING');

    const check = await request(app).get(`/pay/${order.orderId}/check?t=${order.publicToken}`);
    expect(check.status).toBe(200);
    expect(check.body.status).toBe('PENDING');

    const forged = await request(app)
      .post(`/pay/${order.orderId}/check`)
      .type('form')
      .send({ t: order.publicToken, status: 'PAID' });
    expect(forged.status).toBe(302);

    const stored = await query<{ status: string }>('SELECT status FROM payment_orders WHERE id = $1', [order.id]);
    expect(stored.rows[0]?.status).toBe('PENDING');
  });

  it('reflects a confirmed provider webhook on the status endpoint', async () => {
    const owner = await makeUser();
    const merchant = await makeMerchant({ ownerId: owner.id });
    const order = await makeOrder({ merchantId: merchant.id, amountPaise: 15000 });
    const signed = signedSandboxEvent(order);
    await request(app)
      .post('/webhooks/sandbox')
      .set('x-sandbox-signature', signed.signature)
      .set('content-type', 'application/json')
      .send(signed.body)
      .expect(200);

    const status = await request(app).get(`/pay/${order.orderId}/status?t=${order.publicToken}`);
    expect(status.body.status).toBe('PAID');
    expect(status.body.verificationSource).toBe('PROVIDER_WEBHOOK');
  });

  it('hides the sandbox simulator when the sandbox provider is disabled', async () => {
    const owner = await makeUser();
    const merchant = await makeMerchant({ ownerId: owner.id });
    const order = await makeOrder({ merchantId: merchant.id });

    const previous = process.env.ALLOW_SANDBOX_PROVIDER;
    process.env.ALLOW_SANDBOX_PROVIDER = 'false';
    const { resetConfigCache } = await import('../../src/config');
    resetConfigCache();
    const isolated = createApp();
    const res = await request(isolated).get(`/sandbox/pay/${order.orderId}?t=${order.publicToken}`);
    expect(res.status).toBe(404);
    process.env.ALLOW_SANDBOX_PROVIDER = previous;
    resetConfigCache();
  });
});

describe('dashboard reporting', () => {
  it('exports only the signed-in merchant’s orders as CSV', async () => {
    const ownerA = await makeUser();
    const ownerB = await makeUser();
    const merchantA = await makeMerchant({ ownerId: ownerA.id });
    const merchantB = await makeMerchant({ ownerId: ownerB.id });
    const orderA = await makeOrder({ merchantId: merchantA.id });
    const orderB = await makeOrder({ merchantId: merchantB.id });

    const { agent } = await loginAgent(ownerA.email);
    const res = await agent.get('/dashboard/export.csv');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('text/csv');
    expect(res.headers['content-disposition']).toContain('attachment');
    expect(res.text).toContain(orderA.orderId);
    expect(res.text).not.toContain(orderB.orderId);
    expect(res.text).toContain('amount_paise');

    const audit = await query<{ action: string }>('SELECT action FROM audit_logs ORDER BY id DESC LIMIT 1');
    expect(audit.rows[0]?.action).toBe('REPORT_EXPORTED');
  });

  it('finds orders by order id, UTR and status filter', async () => {
    const owner = await makeUser();
    const merchant = await makeMerchant({ ownerId: owner.id });
    const order = await makeOrder({ merchantId: merchant.id, amountPaise: 77000 });
    const signed = signedSandboxEvent(order, { reference: '998877665544' });
    await request(app)
      .post('/webhooks/sandbox')
      .set('x-sandbox-signature', signed.signature)
      .set('content-type', 'application/json')
      .send(signed.body);

    const { agent } = await loginAgent(owner.email);
    const byId = await agent.get(`/dashboard/orders?q=${order.orderId}`);
    expect(byId.text).toContain(order.orderId);
    const byUtr = await agent.get('/dashboard/orders?q=998877665544');
    expect(byUtr.text).toContain(order.orderId);
    const paidOnly = await agent.get('/dashboard/orders?status=PAID');
    expect(paidOnly.text).toContain(order.orderId);
    const pendingOnly = await agent.get('/dashboard/orders?status=PENDING');
    expect(pendingOnly.text).not.toContain(order.orderId);
  });

  it('serves health and readiness probes', async () => {
    const health = await request(app).get('/healthz');
    expect(health.status).toBe(200);
    expect(health.body.status).toBe('ok');
    const ready = await request(app).get('/readyz');
    expect(ready.status).toBe(200);
    expect(ready.body.database).toBe('ok');
  });

  it('sets security headers and does not leak stack traces on errors', async () => {
    const res = await request(app).get('/does-not-exist');
    expect(res.status).toBe(404);
    expect(res.headers['content-security-policy']).toContain("default-src 'self'");
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.text).not.toContain('node_modules');
  });

  it('accepts a merchant-created order only from the authenticated dashboard', async () => {
    const owner = await makeUser();
    const merchant = await makeMerchant({ ownerId: owner.id });
    // API requires authentication.
    await request(app).post('/api/orders').send({ amount: '10.00' }).expect(401);

    const session = await makeSession(owner);
    const res = await request(app)
      .post('/api/orders')
      .set('Cookie', session.cookie)
      .set('x-csrf-token', session.csrfToken)
      .send({ amount: '123.45', description: 'API order' });
    expect(res.status).toBe(201);
    expect(res.body.amount_paise).toBe(12345);
    expect(res.body.payment_url).toMatch(/^\/pay\/PAY-/);
    expect(merchant.id).toBeTruthy();

    const { order } = await createOrder(
      { merchantId: merchant.id, amountPaise: 500, paymentMethod: 'UPI_QR', providerName: 'sandbox' },
      { actorId: null, actorType: 'SYSTEM' },
    );
    expect(order.amountPaise).toBe(500);
  });
});
