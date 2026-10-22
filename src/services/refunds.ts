import { withTransaction } from '../db/pool';
import { AppError } from '../errors';
import { formatPaise, toPaise } from '../domain/money';
import type { Order, Refund } from '../domain/models';
import * as ledger from '../repos/ledger';
import * as orderRepo from '../repos/orders';
import * as ops from '../repos/ops';
import { getProvider } from '../providers/registry';
import type { RefundResult } from '../providers/types';
import { transitionOrder } from './orders';

/**
 * Refunds.
 *
 * Rules:
 *  - a refund is only ever created through an authorised provider interface
 *  - the refundable amount is computed server-side from credited payments
 *  - the provider call happens outside the DB transaction and the local record
 *    is reconciled afterwards (never the other way round)
 *  - every refund is reason-coded and audited
 */

const REFUNDABLE_STATUSES = ['PAID', 'LATE_PAYMENT', 'PARTIALLY_REFUNDED', 'REFUND_PENDING'] as const;

export type RefundReason = Refund['reasonCode'];

export async function requestRefund(input: {
  orderPk: string;
  amountPaise: number;
  reasonCode: RefundReason;
  note: string;
  adminId: string;
  ipHash?: string | null;
}): Promise<{ refund: Refund; order: Order | null }> {
  const amountPaise = toPaise(input.amountPaise);
  if (!input.note || input.note.trim().length < 5) {
    throw new AppError('VALIDATION_ERROR', 'A refund reason note is required', 400);
  }

  const prepared = await withTransaction(async (client) => {
    const order = await orderRepo.lockOrderForUpdate(client, input.orderPk);
    if (!order) throw new AppError('NOT_FOUND', 'Order not found', 404);
    if (!REFUNDABLE_STATUSES.includes(order.status as (typeof REFUNDABLE_STATUSES)[number])) {
      throw new AppError('INVALID_STATE_TRANSITION', `Order status ${order.status} is not refundable`, 409);
    }
    const paid = order.paidAmountPaise ?? 0;
    const already = await ops.sumRefundedPaise(order.id, client);
    if (paid <= 0) throw new AppError('CONFLICT', 'Order has no confirmed payment to refund', 409);
    if (already + amountPaise > paid) {
      throw new AppError(
        'VALIDATION_ERROR',
        `Refund of ₹${formatPaise(amountPaise)} exceeds the remaining refundable amount of ₹${formatPaise(paid - already)}`,
        400,
      );
    }

    const provider = getProvider(order.providerName);
    if (!provider.capabilities.refunds) {
      throw new AppError(
        'PROVIDER_NOT_CONFIGURED',
        `${provider.displayName} does not support API refunds. Refund from the provider dashboard and record it manually.`,
        409,
      );
    }
    const credited = await ledger.findCreditedTransactionForOrder(order.id);
    if (!credited) throw new AppError('CONFLICT', 'No credited transaction found for this order', 409);

    const target = resolveRefundTarget(order, credited);
    if (!target) {
      throw new AppError(
        'PROVIDER_NOT_CONFIGURED',
        'The provider payment reference required for a refund was not captured. Refund manually.',
        409,
      );
    }

    const refund = await ops.insertRefund(client, {
      orderPk: order.id,
      transactionId: credited.id,
      providerName: order.providerName,
      amountPaise,
      reasonCode: input.reasonCode,
      reasonNote: input.note,
      requestedBy: input.adminId,
      status: 'REQUESTED',
    });

    await ops.writeAudit(
      {
        actorId: input.adminId,
        actorType: 'ADMIN',
        action: 'REFUND_REQUESTED',
        resourceType: 'refund',
        resourceId: refund.id,
        metadata: {
          order_id: order.orderId,
          amount_paise: amountPaise,
          reason: input.reasonCode,
          provider: order.providerName,
        },
        ipHash: input.ipHash ?? null,
      },
      client,
    );
    return { refund, order, provider, target };
  });

  let result: RefundResult;
  try {
    result = await prepared.provider.refund({
      // Razorpay refunds a payment id; Cashfree refunds an order id.
      providerPaymentId: prepared.target,
      amountPaise,
      currency: 'INR',
      reasonNote: input.note,
      internalRefundId: prepared.refund.id,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Provider refund failed';
    await withTransaction(async (client) => {
      await ops.updateRefundResult(client, prepared.refund.id, {
        status: 'FAILED',
        providerRefundId: null,
        response: { error: message.slice(0, 300) },
      });
      await ops.writeAudit(
        {
          actorId: input.adminId,
          actorType: 'ADMIN',
          action: 'REFUND_PROVIDER_FAILED',
          resourceType: 'refund',
          resourceId: prepared.refund.id,
          metadata: { error: message.slice(0, 200) },
          ipHash: input.ipHash ?? null,
        },
        client,
      );
    });
    throw new AppError('PROVIDER_UNAVAILABLE', `Refund could not be created at the provider: ${message}`, 502);
  }

  return finalizeProviderRefund({
    refundId: prepared.refund.id,
    providerResult: result,
    amountPaise,
    adminId: input.adminId,
    ipHash: input.ipHash ?? null,
    action: 'REFUND_CREATED',
  });
}

/**
 * Reconciles a refund that is still REQUESTED/PENDING with the provider.
 * Idempotent: the order only moves when the refund transitions to PROCESSED.
 */
export async function reconcileRefund(input: {
  refundId: string;
  adminId: string | null;
  ipHash?: string | null;
}): Promise<{ refund: Refund; order: Order | null }> {
  const refund = await ops.findRefundById(input.refundId);
  if (!refund) throw new AppError('NOT_FOUND', 'Refund not found', 404);
  if (refund.status === 'PROCESSED' || refund.status === 'FAILED' || refund.status === 'CANCELLED') {
    return { refund, order: null };
  }
  if (!refund.providerRefundId) {
    throw new AppError('CONFLICT', 'Refund has no provider reference yet', 409);
  }

  const order = await orderRepo.findOrderByPk(refund.orderPk);
  if (!order) throw new AppError('NOT_FOUND', 'Order not found', 404);
  const provider = getProvider(refund.providerName);
  if (!provider.getRefundStatus) {
    throw new AppError(
      'PROVIDER_NOT_CONFIGURED',
      `${provider.displayName} does not expose refund status; check the provider dashboard and resolve manually.`,
      409,
    );
  }
  const credited = await ledger.findCreditedTransactionForOrder(order.id);
  const target = credited ? resolveRefundTarget(order, credited) : null;
  if (!target) throw new AppError('CONFLICT', 'Missing provider payment reference', 409);

  const status = await provider.getRefundStatus({
    providerRefundId: refund.providerRefundId,
    providerPaymentId: target,
  });

  return finalizeProviderRefund({
    refundId: refund.id,
    providerResult: {
      providerRefundId: refund.providerRefundId,
      status: status.status,
      raw: status.raw,
    },
    amountPaise: refund.amountPaise,
    adminId: input.adminId,
    ipHash: input.ipHash ?? null,
    action: 'REFUND_RECONCILED',
  });
}

async function finalizeProviderRefund(input: {
  refundId: string;
  providerResult: RefundResult;
  amountPaise: number;
  adminId: string | null;
  ipHash: string | null;
  action: string;
}): Promise<{ refund: Refund; order: Order | null }> {
  return withTransaction(async (client) => {
    const existing = await ops.findRefundById(input.refundId);
    if (!existing) throw new AppError('NOT_FOUND', 'Refund not found', 404);
    // Only a refund that has already settled has been counted. A PENDING refund
    // must still move money when the provider later confirms it.
    const alreadyApplied = existing.status === 'PROCESSED';

    // Guard against double counting: only the first transition to a settled
    // state updates the order's refunded total.
    await ops.updateRefundResult(client, existing.id, {
      status: input.providerResult.status,
      providerRefundId: input.providerResult.providerRefundId,
      response: input.providerResult.raw,
    });

    let updatedOrder: Order | null = null;
    if (input.providerResult.status === 'PROCESSED' && !alreadyApplied) {
      const order = await orderRepo.lockOrderForUpdate(client, existing.orderPk);
      if (order) {
        const nextRefunded = order.refundedPaise + existing.amountPaise;
        const paid = order.paidAmountPaise ?? 0;
        const target = nextRefunded >= paid ? 'REFUNDED' : 'PARTIALLY_REFUNDED';
        updatedOrder = await transitionOrder(client, {
          orderPk: order.id,
          toStatus: target,
          refundedPaise: nextRefunded,
          verificationStatus: order.verificationStatus,
          reasonCode: 'REFUND_PROCESSED',
          actorType: input.adminId ? 'ADMIN' : 'SYSTEM',
          actorId: input.adminId,
          note: `Refund ${existing.id} of ${existing.amountPaise} paise processed`,
        });
      }
    } else if (input.providerResult.status === 'PENDING' && !alreadyApplied) {
      const order = await orderRepo.lockOrderForUpdate(client, existing.orderPk);
      if (order && ['PAID', 'LATE_PAYMENT', 'PARTIALLY_REFUNDED'].includes(order.status)) {
        updatedOrder = await transitionOrder(client, {
          orderPk: order.id,
          toStatus: 'REFUND_PENDING',
          verificationStatus: order.verificationStatus,
          reasonCode: 'REFUND_IN_PROGRESS',
          actorType: input.adminId ? 'ADMIN' : 'SYSTEM',
          actorId: input.adminId,
          note: `Refund ${existing.id} pending at provider`,
        });
      }
    }

    await ops.writeAudit(
      {
        actorId: input.adminId,
        actorType: input.adminId ? 'ADMIN' : 'SYSTEM',
        action: input.action,
        resourceType: 'refund',
        resourceId: existing.id,
        metadata: {
          provider_status: input.providerResult.status,
          provider_refund_id: input.providerResult.providerRefundId,
          order_id: updatedOrder?.orderId ?? null,
        },
        ipHash: input.ipHash,
      },
      client,
    );

    // Read through the same transaction: a pool-level read would not see the
    // update above and would return a stale status.
    const settled: Refund = {
      ...existing,
      status: input.providerResult.status,
      providerRefundId: input.providerResult.providerRefundId ?? existing.providerRefundId,
      processedAt: ['PROCESSED', 'FAILED', 'CANCELLED'].includes(input.providerResult.status)
        ? (existing.processedAt ?? new Date())
        : existing.processedAt,
    };
    return { refund: settled, order: updatedOrder };
  });
}

/**
 * The provider-side identifier that a refund must target.
 *  - Razorpay refunds a payment id (pay_...), captured from the webhook/status payload.
 *  - Cashfree refunds an order id (our stored provider payment id).
 */
export function resolveRefundTarget(order: Order, credited: { rawEvidence: Record<string, unknown> }): string | null {
  if (order.providerName === 'razorpay') {
    const paymentId = credited.rawEvidence['paymentId'];
    if (typeof paymentId === 'string' && paymentId.startsWith('pay_')) return paymentId;
    const alt = credited.rawEvidence['provider_payment_id'];
    if (typeof alt === 'string' && alt.length > 0) return alt;
    return null;
  }
  return order.providerPaymentId;
}
