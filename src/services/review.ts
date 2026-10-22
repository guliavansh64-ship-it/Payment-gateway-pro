import { withTransaction } from '../db/pool';
import { AppError } from '../errors';
import type { Order } from '../domain/models';
import * as ledger from '../repos/ledger';
import * as orderRepo from '../repos/orders';
import * as ops from '../repos/ops';
import { isLate } from './status-helpers';
import { transitionOrder } from './orders';

/**
 * Human review actions.
 *
 * Manual confirmation is recorded as source=MANUAL_ENTRY,
 * verification=MANUALLY_VERIFIED and provider=manual_review. It can never be
 * mistaken for — or overwrite — a provider confirmation record. Every action
 * requires a written reason and is written to the append-only audit log.
 */

export async function approveReviewCase(input: {
  caseId: string;
  adminId: string;
  note: string;
  acceptAmountMismatch?: boolean;
  ipHash?: string | null;
}): Promise<{ order: Order }> {
  if (!input.note || input.note.trim().length < 10) {
    throw new AppError('VALIDATION_ERROR', 'A written reason of at least 10 characters is required', 400);
  }

  return withTransaction(async (client) => {
    const reviewCase = await ops.findReconciliationCase(input.caseId);
    if (!reviewCase) throw new AppError('NOT_FOUND', 'Review case not found', 404);
    if (reviewCase.resolutionStatus !== 'OPEN') {
      throw new AppError('CONFLICT', 'This case is already resolved', 409);
    }

    const candidate = reviewCase.candidateTransactionId
      ? await ledger.findTransactionById(reviewCase.candidateTransactionId)
      : null;
    const orderPk = reviewCase.orderPk ?? candidate?.orderPk ?? null;
    if (!orderPk) {
      throw new AppError(
        'VALIDATION_ERROR',
        'This case is not linked to an order. Assign an order before approving payment.',
        400,
      );
    }

    const order = await orderRepo.lockOrderForUpdate(client, orderPk);
    if (!order) throw new AppError('NOT_FOUND', 'Order not found', 404);

    const credited = await ledger.findCreditedTransactionForOrder(order.id);
    if (credited) {
      // Money is already recorded; approve only resolves the case.
      await ops.resolveReconciliationCase(client, {
        id: reviewCase.id,
        resolution: 'RESOLVED_PAID',
        note: input.note,
        reviewedBy: input.adminId,
      });
      await ops.writeAudit(
        {
          actorId: input.adminId,
          actorType: 'ADMIN',
          action: 'REVIEW_CASE_APPROVED_ALREADY_PAID',
          resourceType: 'reconciliation_case',
          resourceId: reviewCase.id,
          metadata: { order_id: order.orderId, transaction_id: credited.id },
          ipHash: input.ipHash ?? null,
        },
        client,
      );
      return { order };
    }

    const received = candidate?.amountPaise ?? order.amountPaise;
    if (received !== order.amountPaise && !input.acceptAmountMismatch) {
      throw new AppError(
        'AMOUNT_MISMATCH',
        `Received ${received} paise but the order is ${order.amountPaise} paise. Explicitly accept the mismatch to approve.`,
        409,
      );
    }

    // Record the manual confirmation as its own ledger entry. The provider name
    // is deliberately NOT the order's payment provider: a human decision must
    // never look like provider evidence.
    const manualReference = `MANUAL-${reviewCase.id.slice(0, 18)}`;
    const now = new Date();

    if (candidate) {
      // The evidence is accepted for audit purposes, but it did not move money.
      await ledger.updateTransaction(client, candidate.id, {
        orderPk: order.id,
        verificationStatus: 'MANUALLY_VERIFIED',
        verifiedAt: now,
        creditedToOrder: false,
        rawEvidence: {
          ...candidate.rawEvidence,
          review_case_id: reviewCase.id,
          approved_by: input.adminId,
        },
      });
    }

    const tx = await ledger.insertTransaction(client, {
      providerName: 'manual_review',
      providerTransactionReference: manualReference,
      providerPaymentId: null,
      orderPk: order.id,
      merchantId: order.merchantId,
      amountPaise: received,
      currency: order.currency,
      transactionStatus: 'SUCCESS',
      verificationStatus: 'MANUALLY_VERIFIED',
      source: 'MANUAL_ENTRY',
      candidateFingerprint: null,
      payeeVpa: order.upiPayeeVpa,
      payerReference: null,
      transactionTimestamp: now,
      verifiedAt: now,
      creditedToOrder: true,
      rawEvidence: {
        review_case_id: reviewCase.id,
        approved_by: input.adminId,
        candidate_transaction_id: candidate?.id ?? null,
        note: input.note.slice(0, 500),
      },
    });

    const target = isLate(order, now) || order.status === 'EXPIRED' ? 'LATE_PAYMENT' : 'PAID';
    const updated = await transitionOrder(client, {
      orderPk: order.id,
      toStatus: target,
      verificationStatus: 'MANUALLY_VERIFIED',
      verificationSource: 'MANUAL_ENTRY',
      paidAt: order.paidAt ?? now,
      paidAmountPaise: received,
      reasonCode: 'MANUAL_APPROVAL',
      actorType: 'ADMIN',
      actorId: input.adminId,
      note: input.note,
      metadataPatch: { manual_review_case: reviewCase.id, manual_received_paise: received },
    });

    await ops.resolveReconciliationCase(client, {
      id: reviewCase.id,
      resolution: 'RESOLVED_PAID',
      note: input.note,
      reviewedBy: input.adminId,
    });
    await ops.writeAudit(
      {
        actorId: input.adminId,
        actorType: 'ADMIN',
        action: 'REVIEW_CASE_APPROVED_MANUALLY',
        resourceType: 'reconciliation_case',
        resourceId: reviewCase.id,
        metadata: {
          order_id: order.orderId,
          transaction_id: tx.id,
          received_paise: received,
          expected_paise: order.amountPaise,
          amount_mismatch_accepted: received !== order.amountPaise,
        },
        ipHash: input.ipHash ?? null,
      },
      client,
    );
    return { order: updated };
  });
}

export async function rejectReviewCase(input: {
  caseId: string;
  adminId: string;
  note: string;
  ipHash?: string | null;
}): Promise<{ order: Order | null }> {
  if (!input.note || input.note.trim().length < 10) {
    throw new AppError('VALIDATION_ERROR', 'A written reason of at least 10 characters is required', 400);
  }
  return withTransaction(async (client) => {
    const reviewCase = await ops.findReconciliationCase(input.caseId);
    if (!reviewCase) throw new AppError('NOT_FOUND', 'Review case not found', 404);
    if (reviewCase.resolutionStatus !== 'OPEN') {
      throw new AppError('CONFLICT', 'This case is already resolved', 409);
    }

    let order: Order | null = null;
    if (reviewCase.orderPk) {
      const locked = await orderRepo.lockOrderForUpdate(client, reviewCase.orderPk);
      const credited = locked ? await ledger.findCreditedTransactionForOrder(locked.id) : null;
      if (locked && !credited && locked.status === 'REVIEW_REQUIRED') {
        const now = new Date();
        const target: 'PENDING' | 'EXPIRED' = now > locked.expiresAt ? 'EXPIRED' : 'PENDING';
        order = await transitionOrder(client, {
          orderPk: locked.id,
          toStatus: target,
          verificationStatus: 'UNVERIFIED',
          reasonCode: 'REVIEW_REJECTED',
          actorType: 'ADMIN',
          actorId: input.adminId,
          note: input.note,
        });
      } else {
        order = locked;
      }
    }

    await ops.resolveReconciliationCase(client, {
      id: reviewCase.id,
      resolution: 'RESOLVED_REJECTED',
      note: input.note,
      reviewedBy: input.adminId,
    });
    await ops.writeAudit(
      {
        actorId: input.adminId,
        actorType: 'ADMIN',
        action: 'REVIEW_CASE_REJECTED',
        resourceType: 'reconciliation_case',
        resourceId: reviewCase.id,
        metadata: { order_id: order?.orderId ?? null },
        ipHash: input.ipHash ?? null,
      },
      client,
    );
    return { order };
  });
}

/** Attaches an ambiguous case to an order without confirming payment. */
export async function assignCaseToOrder(input: {
  caseId: string;
  orderId: string;
  adminId: string;
  ipHash?: string | null;
}): Promise<void> {
  return withTransaction(async (client) => {
    const reviewCase = await ops.findReconciliationCase(input.caseId);
    if (!reviewCase) throw new AppError('NOT_FOUND', 'Review case not found', 404);
    if (reviewCase.resolutionStatus !== 'OPEN') {
      throw new AppError('CONFLICT', 'This case is already resolved', 409);
    }
    const order = await orderRepo.findOrderByOrderId(input.orderId.toUpperCase());
    if (!order) throw new AppError('NOT_FOUND', 'Order not found', 404);
    if (reviewCase.merchantId !== order.merchantId) {
      throw new AppError('FORBIDDEN', 'Case and order belong to different merchants', 403);
    }
    await client.query('UPDATE reconciliation_cases SET order_id = $2 WHERE id = $1', [
      reviewCase.id,
      order.id,
    ]);
    if (reviewCase.candidateTransactionId) {
      await client.query('UPDATE payment_transactions SET order_id = $2 WHERE id = $1', [
        reviewCase.candidateTransactionId,
        order.id,
      ]);
    }
    await ops.writeAudit(
      {
        actorId: input.adminId,
        actorType: 'ADMIN',
        action: 'REVIEW_CASE_ASSIGNED',
        resourceType: 'reconciliation_case',
        resourceId: reviewCase.id,
        metadata: { order_id: order.orderId },
        ipHash: input.ipHash ?? null,
      },
      client,
    );
  });
}
