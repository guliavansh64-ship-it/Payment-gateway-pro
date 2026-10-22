import { describe, expect, it } from 'vitest';
import { query } from '../helpers/db';
import {
  makeMerchant,
  makeOrder,
  makeSession,
  makeUser,
  signedSandboxEvent,
} from '../helpers/fixtures';
import {
  handleGmailMessage,
  syncGmailConnection,
  encryptRefreshToken,
} from '../../src/gmail/service';
import { ingestProviderWebhook } from '../../src/services/payments';
import { upsertGmailConnection } from '../../src/repos/ops';
import type { GmailMessage } from '../../src/gmail/client';

/** Builds a Gmail message object as returned by messages.get?format=full. */
function email(input: {
  id?: string;
  from: string;
  subject?: string;
  text: string;
  date?: Date;
}): GmailMessage {
  const date = input.date ?? new Date();
  return {
    id: input.id ?? `msg-${Math.random().toString(36).slice(2, 12)}`,
    threadId: 'thread-1',
    internalDate: String(date.getTime()),
    payload: {
      mimeType: 'multipart/alternative',
      headers: [
        { name: 'From', value: input.from },
        { name: 'Subject', value: input.subject ?? 'Credit alert for your account' },
        { name: 'Date', value: date.toUTCString() },
      ],
      parts: [
        {
          mimeType: 'text/plain',
          body: { data: Buffer.from(input.text, 'utf8').toString('base64url') },
        },
      ],
    },
  };
}

const connection = (merchantId: string | null) => ({
  id: '00000000-0000-4000-8000-000000000001',
  userId: '00000000-0000-4000-8000-000000000002',
  merchantId,
  providerEmail: 'alerts@example.test',
});

async function creditAlert(amountRupees: string, utr: string, payee: string) {
  return `Rs.${amountRupees} credited to your account ending 1234 from RAMESH KUMAR (ramesh@okaxis). UPI transaction ID: ${utr}. Paid to ${payee}.`;
}

describe('Gmail alerts are candidates, never proof', () => {
  it('cannot mark an order paid on its own (no status API)', async () => {
    const user = await makeUser();
    const merchant = await makeMerchant({ ownerId: user.id, defaultProvider: 'manual_upi' });
    const order = await makeOrder({
      merchantId: merchant.id,
      amountPaise: 49900,
      provider: 'manual_upi',
      paymentMethod: 'UPI_ID',
    });

    const outcome = await handleGmailMessage(
      connection(merchant.id),
      email({
        from: 'HDFC Bank <alerts@hdfcbank.net>',
        text: await creditAlert('499.00', '412345678901', 'aarav.traders@okhdfcbank'),
      }),
    );
    expect(outcome).toBe('REVIEW_REQUIRED');

    const orderRow = await query<{ status: string; verification_source: string | null; paid_at: Date | null }>(
      'SELECT status, verification_source, paid_at FROM payment_orders WHERE order_id = $1',
      [order.orderId],
    );
    expect(orderRow.rows[0]?.status).toBe('REVIEW_REQUIRED');
    expect(orderRow.rows[0]?.verification_source).toBeNull();
    expect(orderRow.rows[0]?.paid_at).toBeNull();

    const tx = await query<{ verification_status: string; credited_to_order: boolean; source: string }>(
      'SELECT verification_status, credited_to_order, source FROM payment_transactions',
    );
    expect(tx.rows[0]?.verification_status).toBe('UNVERIFIED');
    expect(tx.rows[0]?.credited_to_order).toBe(false);
    expect(tx.rows[0]?.source).toBe('GMAIL_NOTIFICATION');

    const cases = await query<{ reason: string }>('SELECT reason FROM reconciliation_cases');
    expect(cases.rows[0]?.reason).toBe('GMAIL_UNVERIFIED');
  });

  it('triggers an authoritative provider check that can confirm payment', async () => {
    const user = await makeUser();
    const merchant = await makeMerchant({ ownerId: user.id });
    const order = await makeOrder({ merchantId: merchant.id, amountPaise: 49900 });

    // Provider-side record — the email did not create this.
    await query(
      `INSERT INTO sandbox_payments
         (provider_payment_id, order_reference, status, amount_paise,
          provider_transaction_reference, payee_vpa, paid_at)
       VALUES ($1,$2,'SUCCESS',49900,'412345678902',$3, now())`,
      [order.providerPaymentId, order.orderId, 'aarav.traders@okhdfcbank'],
    );

    const outcome = await handleGmailMessage(
      connection(merchant.id),
      email({
        from: 'HDFC Bank <alerts@hdfcbank.net>',
        text: await creditAlert('499.00', '412345678902', 'aarav.traders@okhdfcbank'),
      }),
    );
    expect(outcome).toBe('PROCESSED');

    const orderRow = await query<{ status: string; verification_source: string }>(
      'SELECT status, verification_source FROM payment_orders WHERE order_id = $1',
      [order.orderId],
    );
    expect(orderRow.rows[0]?.status).toBe('PAID');
    expect(orderRow.rows[0]?.verification_source).toBe('PROVIDER_API');
  });

  it('ignores a spoofed sender and stores no transaction', async () => {
    const user = await makeUser();
    const merchant = await makeMerchant({ ownerId: user.id });
    await makeOrder({ merchantId: merchant.id, amountPaise: 49900 });

    const outcome = await handleGmailMessage(
      connection(merchant.id),
      email({
        from: '"HDFC Bank" <alerts@hdfcbank.net.evil-domain.top>',
        text: await creditAlert('499.00', '412345678903', 'aarav.traders@okhdfcbank'),
      }),
    );
    expect(outcome).toBe('IGNORED');
    expect((await query('SELECT count(*)::int AS n FROM payment_transactions')).rows[0]?.n).toBe(0);
    expect((await query('SELECT count(*)::int AS n FROM reconciliation_cases')).rows[0]?.n).toBe(0);
    const audit = await query<{ action: string }>('SELECT action FROM audit_logs');
    expect(audit.rows.map((a) => a.action)).toContain('GMAIL_SENDER_REJECTED');
  });

  it('processes the same message id only once', async () => {
    const user = await makeUser();
    const merchant = await makeMerchant({ ownerId: user.id, defaultProvider: 'manual_upi' });
    await makeOrder({
      merchantId: merchant.id,
      amountPaise: 49900,
      provider: 'manual_upi',
      paymentMethod: 'UPI_ID',
    });
    const message = email({
      id: 'duplicate-message-1',
      from: 'HDFC Bank <alerts@hdfcbank.net>',
      text: await creditAlert('499.00', '412345678904', 'aarav.traders@okhdfcbank'),
    });

    const first = await handleGmailMessage(connection(merchant.id), message);
    const second = await handleGmailMessage(connection(merchant.id), message);
    expect(first).toBe('REVIEW_REQUIRED');
    expect(second).toBe('DUPLICATE');
    expect((await query('SELECT count(*)::int AS n FROM payment_transactions')).rows[0]?.n).toBe(1);
    expect((await query('SELECT count(*)::int AS n FROM reconciliation_cases')).rows[0]?.n).toBe(1);
  });

  it('does not guess between two identical orders', async () => {
    const user = await makeUser();
    const merchant = await makeMerchant({ ownerId: user.id, defaultProvider: 'manual_upi' });
    const first = await makeOrder({
      merchantId: merchant.id,
      amountPaise: 25000,
      provider: 'manual_upi',
      paymentMethod: 'UPI_ID',
    });
    const second = await makeOrder({
      merchantId: merchant.id,
      amountPaise: 25000,
      provider: 'manual_upi',
      paymentMethod: 'UPI_ID',
    });

    const outcome = await handleGmailMessage(
      connection(merchant.id),
      email({
        from: 'HDFC Bank <alerts@hdfcbank.net>',
        text: await creditAlert('250.00', '412345678905', 'aarav.traders@okhdfcbank'),
      }),
    );
    expect(outcome).toBe('REVIEW_REQUIRED');

    const rows = await query<{ status: string }>('SELECT status FROM payment_orders');
    expect(rows.rows.map((r) => r.status)).toEqual(['PENDING', 'PENDING']);
    const tx = await query<{ order_id: string | null }>('SELECT order_id FROM payment_transactions');
    expect(tx.rows[0]?.order_id).toBeNull();
    expect([first.orderId, second.orderId]).toHaveLength(2);
  });

  it('corroborates an already-verified payment without crediting twice', async () => {
    const user = await makeUser();
    const merchant = await makeMerchant({ ownerId: user.id });
    const order = await makeOrder({ merchantId: merchant.id, amountPaise: 64000 });

    const signed = signedSandboxEvent(order, { reference: '412345678906' });
    const ingest = await ingestProviderWebhook({
      providerName: 'sandbox',
      rawBody: Buffer.from(signed.body),
      headers: { 'x-sandbox-signature': signed.signature },
    });
    expect(ingest.outcome).toBe('PROCESSED');

    const outcome = await handleGmailMessage(
      connection(merchant.id),
      email({
        from: 'HDFC Bank <alerts@hdfcbank.net>',
        text: await creditAlert('640.00', '412345678906', 'aarav.traders@okhdfcbank'),
      }),
    );
    expect(outcome).toBe('PROCESSED');

    const credited = await query<{ n: number }>(
      'SELECT count(*)::int AS n FROM payment_transactions WHERE credited_to_order',
    );
    expect(credited.rows[0]?.n).toBe(1);
    const all = await query<{ verification_status: string; source: string }>(
      'SELECT verification_status, source FROM payment_transactions ORDER BY created_at',
    );
    expect(all.rows.filter((r) => r.source === 'GMAIL_NOTIFICATION')[0]?.verification_status).toBe('VERIFIED');
    const orderRow = await query<{ status: string }>('SELECT status FROM payment_orders WHERE id = $1', [order.id]);
    expect(orderRow.rows[0]?.status).toBe('PAID');
  });
});

describe('Gmail sync', () => {
  it('reads only allow-listed senders and advances the history cursor', async () => {
    const user = await makeUser();
    const merchant = await makeMerchant({ ownerId: user.id, defaultProvider: 'manual_upi' });
    await makeOrder({
      merchantId: merchant.id,
      amountPaise: 31000,
      provider: 'manual_upi',
      paymentMethod: 'UPI_ID',
    });

    process.env.GOOGLE_CLIENT_ID = 'test-client';
    process.env.GOOGLE_CLIENT_SECRET = 'test-secret';
    process.env.GOOGLE_OAUTH_REDIRECT_URI = 'http://localhost:3000/oauth/google/callback';
    const { resetConfigCache } = await import('../../src/config');
    resetConfigCache();

    const dbConnection = await upsertGmailConnection({
      userId: user.id,
      merchantId: merchant.id,
      providerEmail: 'alerts@example.test',
      encryptedRefreshToken: encryptRefreshToken(user.id, '1//refresh-token'),
      tokenKeyVersion: 'v1',
      grantedScopes: ['https://www.googleapis.com/auth/gmail.readonly'],
    });

    const message = email({
      id: 'sync-message-1',
      from: 'HDFC Bank <alerts@hdfcbank.net>',
      text: await creditAlert('310.00', '412345678907', 'aarav.traders@okhdfcbank'),
    });

    const calls: string[] = [];
    const fakeFetch = async (input: Parameters<typeof fetch>[0]): Promise<Response> => {
      const url = String(input);
      calls.push(url);
      if (url.includes('oauth2.googleapis.com/token')) {
        return new Response(JSON.stringify({ access_token: 'ya29.test', expires_in: 3600 }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (url.endsWith('/profile')) {
        return new Response(JSON.stringify({ emailAddress: 'alerts@example.test', historyId: '999', messagesTotal: 1 }), {
          status: 200,
        });
      }
      if (url.includes('/messages?') && !url.includes('/messages/sync-message-1')) {
        return new Response(JSON.stringify({ messages: [{ id: 'sync-message-1', threadId: 't1' }] }), { status: 200 });
      }
      if (url.includes('/messages/sync-message-1')) {
        return new Response(JSON.stringify(message), { status: 200 });
      }
      return new Response('not found', { status: 404 });
    };

    const summary = await syncGmailConnection(
      {
        id: dbConnection.id,
        userId: user.id,
        merchantId: merchant.id,
        providerEmail: 'alerts@example.test',
        encryptedRefreshToken: encryptRefreshToken(user.id, '1//refresh-token'),
        historyCursor: null,
      },
      { fetchImpl: fakeFetch as typeof fetch },
    );

    expect(summary.messagesSeen).toBe(1);
    expect(summary.processed + summary.reviewRequired).toBe(1);
    expect(summary.newCursor).toBe('999');
    expect(calls.some((c) => decodeURIComponent(c).includes('from:hdfcbank.net'))).toBe(true);
    const stored = await query<{ history_cursor: string }>(
      'SELECT history_cursor FROM gmail_connections WHERE id = $1',
      [dbConnection.id],
    );
    expect(stored.rows[0]?.history_cursor).toBe('999');
  });

  it('refuses to sync when no sender domains are configured', async () => {
    process.env.GMAIL_ALLOWED_SENDER_DOMAINS = '';
    const { resetConfigCache } = await import('../../src/config');
    resetConfigCache();
    const user = await makeUser();
    const connectionRow = await upsertGmailConnection({
      userId: user.id,
      merchantId: null,
      providerEmail: 'alerts@example.test',
      encryptedRefreshToken: encryptRefreshToken(user.id, '1//refresh-token'),
      tokenKeyVersion: 'v1',
      grantedScopes: [],
    });
    await expect(
      syncGmailConnection({
        id: connectionRow.id,
        userId: user.id,
        merchantId: null,
        providerEmail: 'alerts@example.test',
        encryptedRefreshToken: encryptRefreshToken(user.id, '1//refresh-token'),
        historyCursor: null,
      }),
    ).rejects.toThrow(/sender domains/i);
  });
});
