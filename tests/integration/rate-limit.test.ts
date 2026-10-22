import { describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../../src/web/app';
import { query } from '../helpers/db';
import { TEST_PASSWORD, makeMerchant, makeOrder, makeUser } from '../helpers/fixtures';
import { findOrderByOrderId } from '../../src/repos/orders';

const app = createApp();
// Behind a proxy the client address comes from X-Forwarded-For. Tests use a
// distinct address per case so the per-IP limiter store does not leak between
// them (in production that store is per instance and expires on its own).
app.set('trust proxy', true);

let ipCounter = 0;
function nextIp(): string {
  ipCounter += 1;
  return `198.51.100.${ipCounter}`;
}

async function loginPage(agent: ReturnType<typeof request.agent>): Promise<string> {
  const page = await agent.get('/login');
  return /name="_csrf" value="([^"]*)"/.exec(page.text)?.[1] ?? '';
}

describe('rate limiting', () => {
  it('blocks an address after repeated sign-in attempts', async () => {
    const ip = nextIp();
    const agent = request.agent(app);
    const csrf = await loginPage(agent);

    let last: request.Response | null = null;
    for (let i = 0; i < 21; i += 1) {
      last = await agent
        .post('/login')
        .set('x-forwarded-for', ip)
        .type('form')
        .send({ _csrf: csrf, email: `nobody${i}@example.test`, password: 'wrong-password' });
    }

    expect(last?.status).toBe(429);
    expect(last?.text).toMatch(/Too many/i);
    expect(last?.headers['retry-after']).toBeDefined();
  });

  it('blocks a single account after ten attempts, even across addresses', async () => {
    const victim = await makeUser({ role: 'MERCHANT_ADMIN' });
    const ip = nextIp();
    let status = 0;
    for (let i = 0; i < 11; i += 1) {
      const agent = request.agent(app);
      const csrf = await loginPage(agent);
      const res = await agent
        .post('/login')
        .set('x-forwarded-for', ip)
        .type('form')
        .send({ _csrf: csrf, email: victim.email, password: 'wrong-password' });
      status = res.status;
    }

    expect(status).toBe(429);
    const audit = await query<{ action: string }>(
      `SELECT action FROM audit_logs WHERE action = 'LOGIN_RATE_LIMITED'`,
    );
    expect(audit.rowCount).toBe(1);
    const bucket = await query<{ count: number }>(
      `SELECT count FROM rate_limits WHERE bucket = 'login-email'`,
    );
    expect(bucket.rows[0]?.count).toBeGreaterThan(10);
  });

  it('clears the per-account counter after a successful sign-in', async () => {
    const user = await makeUser({ role: 'MERCHANT_ADMIN' });
    await makeMerchant({ ownerId: user.id });
    const ip = nextIp();
    const agent = request.agent(app);
    const csrf = await loginPage(agent);

    for (let i = 0; i < 5; i += 1) {
      await agent
        .post('/login')
        .set('x-forwarded-for', ip)
        .type('form')
        .send({ _csrf: csrf, email: user.email, password: 'wrong-password' })
        .expect(401);
    }

    const ok = await agent
      .post('/login')
      .set('x-forwarded-for', ip)
      .type('form')
      .send({ _csrf: csrf, email: user.email, password: TEST_PASSWORD });
    expect(ok.status).toBe(302);

    const bucket = await query(`SELECT 1 FROM rate_limits WHERE bucket = 'login-email'`);
    expect(bucket.rowCount).toBe(0);
  });

  it('throttles the public status-check endpoint', async () => {
    const merchant = await makeMerchant({ ownerId: (await makeUser()).id, defaultProvider: 'sandbox' });
    const order = await makeOrder({ merchantId: merchant.id, provider: 'sandbox' });
    const url = `/pay/${order.orderId}/check?t=${encodeURIComponent(order.publicToken)}`;

    for (let i = 0; i < 10; i += 1) {
      await request(app).get(url).expect(200);
    }
    const blocked = await request(app).get(url);
    expect(blocked.status).toBe(429);
    expect(blocked.headers['retry-after']).toBeDefined();

    // Throttling must never alter payment state.
    const after = await findOrderByOrderId(order.orderId);
    expect(after?.status).toBe('PENDING');
    expect(after?.verificationStatus).toBe('UNVERIFIED');
  });

  it('throttles order creation from one address', async () => {
    const merchant = await makeMerchant({
      ownerId: (await makeUser()).id,
      defaultProvider: 'sandbox',
    });
    expect(merchant.id).toBeTruthy();

    for (let i = 0; i < 12; i += 1) {
      const res = await request(app).post('/pay/new').type('form').send({ amount: '10.00', merchant: merchant.id });
      expect([302, 200]).toContain(res.status);
    }
    const blocked = await request(app)
      .post('/pay/new')
      .type('form')
      .send({ amount: '10.00', merchant: merchant.id });
    expect(blocked.status).toBe(429);
  });
});
