import { describe, expect, it } from 'vitest';
import { query } from '../helpers/db';
import { latestCase, makeMerchant, makeOrder, makeUser, signedSandboxEvent } from '../helpers/fixtures';
import { ingestProviderWebhook } from '../../src/services/payments';
import { approveReviewCase, assignCaseToOrder, rejectReviewCase } from '../../src/services/review';
import { reconcileRefund, requestRefund } from '../../src/services/refunds';

async function payByWebhook(order: Awaited<ReturnType<typeof makeOrder>>, reference?: string) {
  const signed = signedSandboxEvent(order, reference ? { reference } : {});
  return ingestProviderWebhook({
    providerName: 'sandbox',
    rawBody: Buffer.from(signed.body),
    headers: { 'x-sandbox-signature': signed.signature },
  });
}

/** Creates an order plus an open Gmail-style review case, without a provider payment. */
async function openManualCase(amountPaise = 49900) {
  const owner = await makeUser();
  const admin = await makeUser({ role: 'ADMIN' });
  const merchant = await makeMerchant({ ownerId: owner.id, defaultProvider: 'manual_upi' });
  const order = await makeOrder({
    merchantId: merchant.id,
    amountPaise,
    provider: 'manual_upi',
    paymentMethod: 'UPI_ID',
  });
  const { handleGmailMessage } = await import('../../src/gmail/service');
  const message = {
    id: `msg-${Math.random().toString(36).slice(2, 12)}`,
    threadId: 't',
    internalDate: String(Date.now()),
    payload: {
      mimeType: 'text/plain',
      headers: [
        { name: 'From', value: 'HDFC Bank <alerts@hdfcbank.net>' },
        { name: 'Subject', value: 'Credit alert' },
        { name: 'Date', value: new Date().toUTCString() },
      ],
      body: {
        data: Buffer.from(
          `Rs.${(amountPaise / 100).toFixed(2)} credited from RAMESH KUMAR (ramesh@okaxis). UPI transaction ID: ${
            412345670000 + Math.floor(Math.random() * 1000)
          }.`,
          'utf8',
        ).toString('base64url'),
      },
    },
  };
  const outcome = await handleGmailMessage(
    { id: '00000000-0000-4000-8000-00000000000c', userId: owner.id, merchantId: merchant.id, providerEmail: 'a@b.test' },
    message,
  );
  expect(outcome).toBe('REVIEW_REQUIRED');
  const reviewCase = await latestCase();
  expect(reviewCase).not.toBeNull();
  return { owner, admin, merchant, order, adminId: admin.id, caseId: reviewCase!.id };
}

describe('manual review', () => {
  it('approves a case as MANUALLY_VERIFIED without fabricating provider proof', async () => {
    const { order, adminId, caseId } = await openManualCase();

    const result = await approveReviewCase({
      caseId,
      adminId,
      note: 'Bank statement shows the credit; verified against the merchant account.',
    });
    expect(result.order.status).toBe('PAID');
    expect(result.order.verificationStatus).toBe('MANUALLY_VERIFIED');
    expect(result.order.verificationSource).toBe('MANUAL_ENTRY');

    const tx = await query<{ provider_name: string; source: string; verification_status: string; credited_to_order: boolean }>(
      'SELECT provider_name, source, verification_status, credited_to_order FROM payment_transactions WHERE credited_to_order',
    );
    expect(tx.rows).toHaveLength(1);
    expect(tx.rows[0]?.provider_name).toBe('manual_review');
    expect(tx.rows[0]?.source).toBe('MANUAL_ENTRY');
    expect(tx.rows[0]?.verification_status).toBe('MANUALLY_VERIFIED');

    const audit = await query<{ action: string }>('SELECT action FROM audit_logs ORDER BY id DESC LIMIT 1');
    expect(audit.rows[0]?.action).toBe('REVIEW_CASE_APPROVED_MANUALLY');
    const closed = await query<{ resolution_status: string; reviewed_by: string | null }>(
      'SELECT resolution_status, reviewed_by FROM reconciliation_cases WHERE id = $1',
      [caseId],
    );
    expect(closed.rows[0]?.resolution_status).toBe('RESOLVED_PAID');
    expect(closed.rows[0]?.reviewed_by).toBe(adminId);
    expect(order.status).toBe('PENDING');
  });

  it('requires a written reason and refuses a second decision', async () => {
    const { adminId, caseId } = await openManualCase();
    await expect(approveReviewCase({ caseId, adminId, note: 'ok' })).rejects.toThrow(/at least 10/i);
    await approveReviewCase({ caseId, adminId, note: 'Verified with the bank statement PDF on file.' });
    await expect(
      approveReviewCase({ caseId, adminId, note: 'Verified with the bank statement PDF on file.' }),
    ).rejects.toThrow(/already resolved/i);
  });

  it('rejects a case and returns the order to a payable state', async () => {
    const { order, adminId, caseId } = await openManualCase();
    await rejectReviewCase({ caseId, adminId, note: 'No matching credit appeared on the bank statement.' });
    const row = await query<{ status: string; verification_status: string }>(
      'SELECT status, verification_status FROM payment_orders WHERE id = $1',
      [order.id],
    );
    expect(row.rows[0]?.status).toBe('PENDING');
    expect(row.rows[0]?.verification_status).toBe('UNVERIFIED');
  });

  it('can attach an unassigned case to an order', async () => {
    const { merchant, adminId, caseId } = await openManualCase();
    const target = await makeOrder({
      merchantId: merchant.id,
      amountPaise: 49900,
      provider: 'manual_upi',
      paymentMethod: 'UPI_ID',
    });
    await query('UPDATE reconciliation_cases SET order_id = NULL WHERE id = $1', [caseId]);
    await assignCaseToOrder({ caseId, orderId: target.orderId, adminId });
    const row = await query<{ order_id: string | null }>('SELECT order_id FROM reconciliation_cases WHERE id = $1', [caseId]);
    expect(row.rows[0]?.order_id).toBe(target.id);
  });
});

describe('refunds through the provider API', () => {
  it('refunds in full and moves the order to REFUNDED', async () => {
    const owner = await makeUser();
    const admin = await makeUser({ role: 'ADMIN' });
    const merchant = await makeMerchant({ ownerId: owner.id });
    const order = await makeOrder({ merchantId: merchant.id, amountPaise: 49900 });
    await payByWebhook(order, '500000000001');

    const { refund, order: updated } = await requestRefund({
      orderPk: order.id,
      amountPaise: 49900,
      reasonCode: 'REQUESTED_BY_CUSTOMER',
      note: 'Customer cancelled the order before dispatch.',
      adminId: admin.id,
    });
    expect(refund.status).toBe('PROCESSED');
    expect(updated?.status).toBe('REFUNDED');

    const stored = await query<{ status: string; refunded_paise: string }>(
      'SELECT status, refunded_paise FROM payment_orders WHERE id = $1',
      [order.id],
    );
    expect(stored.rows[0]?.status).toBe('REFUNDED');
    expect(stored.rows[0]?.refunded_paise).toBe('49900');
    const audits = await query<{ action: string }>('SELECT action FROM audit_logs');
    expect(audits.rows.map((a) => a.action)).toContain('REFUND_REQUESTED');
    expect(audits.rows.map((a) => a.action)).toContain('REFUND_CREATED');
  });

  it('supports partial refunds and refuses to over-refund', async () => {
    const owner = await makeUser();
    const admin = await makeUser({ role: 'ADMIN' });
    const merchant = await makeMerchant({ ownerId: owner.id });
    const order = await makeOrder({ merchantId: merchant.id, amountPaise: 100000 });
    await payByWebhook(order, '500000000002');

    const first = await requestRefund({
      orderPk: order.id,
      amountPaise: 30000,
      reasonCode: 'OTHER',
      note: 'One of three items was out of stock.',
      adminId: admin.id,
    });
    expect(first.order?.status).toBe('PARTIALLY_REFUNDED');

    await expect(
      requestRefund({
        orderPk: order.id,
        amountPaise: 80000,
        reasonCode: 'REQUESTED_BY_CUSTOMER',
        note: 'Trying to refund more than remains.',
        adminId: admin.id,
      }),
    ).rejects.toThrow(/remaining refundable/i);

    const second = await requestRefund({
      orderPk: order.id,
      amountPaise: 70000,
      reasonCode: 'REQUESTED_BY_CUSTOMER',
      note: 'Remaining balance refunded after return.',
      adminId: admin.id,
    });
    expect(second.order?.status).toBe('REFUNDED');
  });

  it('refuses refunds for orders without confirmed money', async () => {
    const owner = await makeUser();
    const admin = await makeUser({ role: 'ADMIN' });
    const merchant = await makeMerchant({ ownerId: owner.id });
    const order = await makeOrder({ merchantId: merchant.id, amountPaise: 49900 });

    await expect(
      requestRefund({
        orderPk: order.id,
        amountPaise: 100,
        reasonCode: 'REQUESTED_BY_CUSTOMER',
        note: 'No payment was received.',
        adminId: admin.id,
      }),
    ).rejects.toThrow(/not refundable/i);
  });

  it('reconciles a pending refund once the provider settles it', async () => {
    const owner = await makeUser();
    const admin = await makeUser({ role: 'ADMIN' });
    const merchant = await makeMerchant({ ownerId: owner.id });
    const order = await makeOrder({ merchantId: merchant.id, amountPaise: 25000 });
    await payByWebhook(order, '500000000003');

    const credited = await query<{ id: string }>(
      'SELECT id FROM payment_transactions WHERE credited_to_order LIMIT 1',
    );
    const txId = credited.rows[0]!.id;
    const inserted = await query<{ id: string }>(
      `INSERT INTO refunds (order_pk, transaction_id, provider_name, provider_refund_id,
                            amount_paise, status, reason_code, reason_note, requested_by)
       VALUES ($1,$2,'sandbox','sbxrf_pending_1',25000,'PENDING','REQUESTED_BY_CUSTOMER',
               'Refund submitted, awaiting provider settlement.', $3)
       RETURNING id`,
      [order.id, txId, admin.id],
    );
    const refundId = inserted.rows[0]!.id;

    const result = await reconcileRefund({ refundId, adminId: admin.id });
    expect(result.refund.status).toBe('PROCESSED');
    expect(result.order?.status).toBe('REFUNDED');

    // Idempotent: reconciling again must not double-count.
    await reconcileRefund({ refundId, adminId: admin.id });
    const stored = await query<{ refunded_paise: string }>(
      'SELECT refunded_paise FROM payment_orders WHERE id = $1',
      [order.id],
    );
    expect(stored.rows[0]?.refunded_paise).toBe('25000');
  });
});
