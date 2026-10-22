import type { PoolClient } from 'pg';
import { getConfig } from '../config';
import { withTransaction } from '../db/pool';
import { AppError, ProviderError, WebhookSignatureError } from '../errors';
import type { Merchant, Order, ReconciliationReason } from '../domain/models';
import type { OrderStatus, TransactionSource, TransactionStatus } from '../domain/status';
import { isLate } from './status-helpers';
import { sha256 } from '../security/crypto';
import { getLogger } from '../observability/logger';
import * as ledger from '../repos/ledger';
import * as merchantRepo from '../repos/merchants';
import * as orderRepo from '../repos/orders';
import * as ops from '../repos/ops';
import { getProvider, assertProviderAllowed, tryGetProvider } from '../providers/registry';
import type {
  NormalizedWebhook,
  ProviderPaymentStatus,
  StatusResult,
} from '../providers/types';
import { matchTransaction, type MatchCandidate, type MatchDecision } from './matching';
import { transitionOrder } from './orders';
import { normalizeReference } from './reference';

/**
 * Ingestion and application of payment evidence.
 *
 * Invariants enforced here (and by DB constraints):
 *  - a provider event is processed at most once (payment_events.event_id UNIQUE)
 *  - a provider transaction reference maps to at most one transaction row
 *  - at most one transaction is credited to an order
 *  - only authoritative sources (provider webhook/API/reconciliation) can move
 *    an order to PAID; Gmail is a trigger, never a proof
 */

export type NormalizedCandidate = {
  providerName: string;
  providerTransactionReference: string | null;
  providerPaymentId: string | null;
  providerOrderReference: string | null;
  internalOrderReference: string | null;
  amountPaise: number | null;
  currency: string;
  status: TransactionStatus;
  paidAt: Date | null;
  payeeVpa: string | null;
  failureReason: string | null;
  source: TransactionSource;
  eventId: string | null;
  raw: Record<string, unknown>;
};

export type IngestResult = {
  httpStatus: number;
  outcome:
    | 'PROCESSED'
    | 'DUPLICATE'
    | 'IGNORED'
    | 'REVIEW_REQUIRED'
    | 'FAILED_RETRYABLE'
    | 'REJECTED';
  eventId: string | null;
  detail?: string;
};

// ---------------------------------------------------------------------------
// webhook ingestion
// ---------------------------------------------------------------------------

export async function ingestProviderWebhook(input: {
  providerName: string;
  rawBody: Buffer;
  headers: Record<string, string | string[] | undefined>;
  ipHash?: string | null;
}): Promise<IngestResult> {
  const provider = getProvider(input.providerName);
  assertProviderAllowed(input.providerName);
  if (!provider.capabilities.webhooks) {
    throw new AppError('PROVIDER_NOT_CONFIGURED', 'Provider does not support webhooks', 404);
  }

  // 1. Authenticity first — before parsing anything beyond JSON syntax.
  const verification = await provider.verifyWebhook(input.rawBody, input.headers);
  if (!verification.timestampFresh) {
    throw new WebhookSignatureError('Webhook rejected: timestamp outside the replay window');
  }

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(input.rawBody.toString('utf8')) as Record<string, unknown>;
  } catch {
    throw new AppError('WEBHOOK_MALFORMED', 'Webhook body is not valid JSON', 400);
  }

  const normalized = provider.parseWebhook(parsed);
  normalized.eventId = verification.eventId;

  // 2. Store the event idempotently, with personal data stripped.
  const sanitized = sanitizeForStorage(parsed);
  sanitized._provider = input.providerName;
  const recorded = await ledger.recordEvent({
    eventId: verification.eventId,
    orderPk: null,
    paymentOrderRef: normalized.internalOrderReference,
    eventType: verification.eventType,
    source: 'PROVIDER_WEBHOOK',
    sourceReference: normalized.providerTransactionReference,
    eventPayloadHash: sha256(input.rawBody),
    payload: sanitized,
  });

  if (!recorded.inserted) {
    // A provider retrying after our transient failure must be re-processed, not
    // swallowed as a duplicate. Only successfully processed events are final.
    if (recorded.event.processingStatus === 'FAILED') {
      return processEvent(recorded.event.eventId, normalized, input.providerName, input.ipHash ?? null);
    }
    await ledger.markEventProcessed(verification.eventId, 'DUPLICATE');
    return { httpStatus: 200, outcome: 'DUPLICATE', eventId: verification.eventId };
  }

  return processEvent(recorded.event.eventId, normalized, input.providerName, input.ipHash ?? null);
}

export async function processEvent(
  eventId: string,
  normalized: NormalizedWebhook,
  providerName: string,
  ipHash: string | null,
): Promise<IngestResult> {
  await ledger.markEventProcessing(eventId);
  try {
    const candidate: NormalizedCandidate = {
      providerName,
      providerTransactionReference: normalized.providerTransactionReference
        ? normalizeReference(normalized.providerTransactionReference)
        : null,
      providerPaymentId: normalized.providerPaymentId,
      providerOrderReference: normalized.providerOrderReference,
      internalOrderReference: normalized.internalOrderReference,
      amountPaise: normalized.amountPaise,
      currency: normalized.currency || 'INR',
      status: providerStatusToTransactionStatus(normalized.status),
      paidAt: normalized.paidAt,
      payeeVpa: normalized.payeeVpa,
      failureReason: normalized.failureReason,
      source: 'PROVIDER_WEBHOOK',
      eventId,
      raw: {
        provider_event: normalized.eventType,
        payment_id: normalized.providerPaymentId,
      },
    };

    const merchant = await resolveMerchantForCandidate(candidate);
    if (!merchant) {
      await ledger.markEventProcessed(eventId, 'IGNORED');
      await ops.writeAudit({
        actorId: null,
        actorType: 'PROVIDER',
        action: 'WEBHOOK_MERCHANT_UNRESOLVED',
        resourceType: 'payment_event',
        resourceId: eventId,
        metadata: { provider: providerName },
        ipHash,
      });
      return {
        httpStatus: 200,
        outcome: 'IGNORED',
        eventId,
        detail: 'No merchant is associated with this provider account',
      };
    }

    const decision = await matchTransaction(toMatchCandidate(candidate), merchant.id);
    const result = await applyDecision({
      candidate,
      merchant,
      decision,
      eventId,
      ipHash,
      verificationSource: 'PROVIDER_WEBHOOK',
    });
    await ledger.markEventProcessed(
      eventId,
      result.outcome === 'REVIEW_REQUIRED' ? 'PROCESSED' : result.outcome === 'DUPLICATE' ? 'DUPLICATE' : 'PROCESSED',
    );
    return result;
  } catch (err) {
    if (err instanceof ProviderError && err.retryable) {
      // Provider outage during a lookup: let the provider retry the webhook.
      await ledger.markEventFailed(eventId, err.message, 60);
      return { httpStatus: 503, outcome: 'FAILED_RETRYABLE', eventId, detail: err.message };
    }
    if (err instanceof AppError && err.statusCode < 500) {
      await ledger.markEventProcessed(eventId, 'IGNORED');
      return { httpStatus: 200, outcome: 'IGNORED', eventId, detail: err.message };
    }
    await ledger.markEventFailed(eventId, err instanceof Error ? err.message : 'unknown error', 120);
    throw err;
  }
}

// ---------------------------------------------------------------------------
// decision application
// ---------------------------------------------------------------------------

type ApplyArgs = {
  candidate: NormalizedCandidate;
  merchant: Merchant;
  decision: MatchDecision;
  eventId: string | null;
  ipHash?: string | null;
  verificationSource: TransactionSource;
};

async function applyDecision(args: ApplyArgs): Promise<IngestResult> {
  const { candidate, merchant, decision, eventId } = args;

  if (decision.outcome === 'ALREADY_LINKED' && decision.order) {
    const linkedOrder = decision.order;
    const existingTx = candidate.providerTransactionReference
      ? await ledger.findTransactionByProviderReference(
          candidate.providerName,
          candidate.providerTransactionReference,
        )
      : null;

    // A reference we have never seen, for an order that already holds money or
    // has already been decided. That is new information, not a retry.
    if (!existingTx) {
      if (candidate.status === 'SUCCESS') {
        return applyAuthoritativeSuccess({ ...args, order: linkedOrder });
      }
      if (candidate.status === 'REVERSED' || candidate.status === 'REFUNDED') {
        return applyReversal({ ...args, order: linkedOrder });
      }
      return applyUnknown({ ...args, order: linkedOrder });
    }

    // Same reference, but the provider now reports it reversed or refunded.
    // Never silently ignore money moving backwards.
    if (
      (candidate.status === 'REVERSED' || candidate.status === 'REFUNDED') &&
      (existingTx.creditedToOrder || linkedOrder.status === 'PAID' || linkedOrder.status === 'LATE_PAYMENT')
    ) {
      return applyReversal({ ...args, order: linkedOrder });
    }

    // The reference is already attached to an order. If that transaction is
    // still unverified, upgrade it; otherwise it is a true duplicate.
    return withTransaction(async (client) => {
      const lockedTx = await findTxForUpdate(
        client,
        candidate.providerName,
        candidate.providerTransactionReference as string,
      );
      if (lockedTx && lockedTx.verificationStatus !== 'VERIFIED' && candidate.status === 'SUCCESS') {
        await ledger.updateTransaction(client, lockedTx.id, {
          verificationStatus: 'VERIFIED',
          verifiedAt: new Date(),
          transactionStatus: 'SUCCESS',
          source: candidate.source,
        });
        await ops.writeAudit(
          {
            actorId: null,
            actorType: 'PROVIDER',
            action: 'TRANSACTION_CORROBORATED',
            resourceType: 'payment_transaction',
            resourceId: lockedTx.id,
            metadata: { order_id: linkedOrder.orderId, event_id: eventId },
            ipHash: args.ipHash ?? null,
          },
          client,
        );
        return { httpStatus: 200, outcome: 'PROCESSED' as const, eventId };
      }
      await ops.writeAudit(
        {
          actorId: null,
          actorType: 'PROVIDER',
          action: 'DUPLICATE_WEBHOOK_IGNORED',
          resourceType: 'payment_order',
          resourceId: linkedOrder.orderId,
          metadata: { event_id: eventId, reference: candidate.providerTransactionReference },
          ipHash: args.ipHash ?? null,
        },
        client,
      );
      return { httpStatus: 200, outcome: 'DUPLICATE' as const, eventId };
    });
  }

  if (decision.outcome === 'AMBIGUOUS' || decision.outcome === 'CONFLICT' ||
      decision.outcome === 'NO_ORDER' || decision.outcome === 'INSUFFICIENT_EVIDENCE') {
    return withTransaction(async (client) => {
      const tx = await recordCandidateTransaction(client, {
        candidate,
        merchantId: merchant.id,
        orderPk: decision.order?.id ?? null,
        verificationStatus: 'REVIEW_REQUIRED',
        credited: false,
      });
      const reason: ReconciliationReason =
        candidate.status !== 'SUCCESS'
          ? 'OTHER'
          : (decision.reasons[0] ?? 'AMBIGUOUS_MATCH');
      await ops.openReconciliationCase(
        {
          merchantId: merchant.id,
          candidateTransactionId: tx.id,
          orderPk: decision.order?.id ?? null,
          possibleOrderIds: decision.candidateOrders.map((o) => o.orderId),
          reason,
          detail: [
            `outcome=${decision.outcome}`,
            `strategy=${decision.strategy}`,
            ...decision.evidence,
            candidate.failureReason ? `provider: ${candidate.failureReason}` : '',
          ]
            .filter(Boolean)
            .join(' | '),
        },
        client,
      );

      // Only a *single* candidate order is escalated to review; an ambiguous
      // set leaves every order untouched.
      if (decision.outcome === 'INSUFFICIENT_EVIDENCE' && decision.order) {
        const fresh = await orderRepo.lockOrderForUpdate(client, decision.order.id);
        if (fresh && ['CREATED', 'PENDING', 'VERIFYING', 'EXPIRED'].includes(fresh.status)) {
          if (candidate.status === 'SUCCESS') {
            await transitionOrder(client, {
              orderPk: fresh.id,
              toStatus: 'REVIEW_REQUIRED',
              verificationStatus: 'REVIEW_REQUIRED',
              reasonCode: 'PAYMENT_NEEDS_REVIEW',
              actorType: 'SYSTEM',
              note: decision.evidence.join(' | ').slice(0, 500),
              metadataPatch: { review_reason: reason },
            });
          }
        }
      }
      await ops.writeAudit(
        {
          actorId: null,
          actorType: 'PROVIDER',
          action: 'PAYMENT_REVIEW_REQUIRED',
          resourceType: 'payment_transaction',
          resourceId: tx.id,
          metadata: {
            outcome: decision.outcome,
            strategy: decision.strategy,
            reasons: decision.reasons,
            event_id: eventId,
          },
          ipHash: args.ipHash ?? null,
        },
        client,
      );
      return { httpStatus: 200, outcome: 'REVIEW_REQUIRED' as const, eventId };
    });
  }

  // LINKED with trusted evidence.
  const order = decision.order;
  if (!order) {
    return { httpStatus: 200, outcome: 'IGNORED', eventId, detail: 'No order linked' };
  }

  if (candidate.status === 'SUCCESS') {
    return applyAuthoritativeSuccess({ ...args, order });
  }
  if (candidate.status === 'FAILED') {
    return applyAuthoritativeFailure({ ...args, order });
  }
  if (candidate.status === 'PENDING') {
    return applyAuthoritativePending({ ...args, order });
  }
  if (candidate.status === 'REVERSED' || candidate.status === 'REFUNDED') {
    return applyReversal({ ...args, order });
  }
  return applyUnknown({ ...args, order });
}

// ---------------------------------------------------------------------------
// success
// ---------------------------------------------------------------------------

async function applyAuthoritativeSuccess(args: ApplyArgs & { order: Order }): Promise<IngestResult> {
  const { candidate, order, verificationSource, eventId, merchant } = args;

  return withTransaction(async (client) => {
    const locked = await orderRepo.lockOrderForUpdate(client, order.id);
    if (!locked) throw new AppError('NOT_FOUND', 'Order not found', 404);

    // Idempotency at the money level: the same reference must never be credited twice.
    if (candidate.providerTransactionReference) {
      const existingTx = await findTxForUpdate(client, candidate.providerName, candidate.providerTransactionReference);
      if (existingTx?.creditedToOrder && existingTx.orderPk === locked.id) {
        return { httpStatus: 200, outcome: 'DUPLICATE' as const, eventId };
      }
    }

    // Amount verification (server-side, integer paise).
    if (candidate.amountPaise !== null && candidate.amountPaise !== locked.amountPaise) {
      const tx = await recordCandidateTransaction(client, {
        candidate,
        merchantId: merchant.id,
        orderPk: locked.id,
        verificationStatus: 'VERIFIED',
        credited: false,
      });
      await ops.openReconciliationCase(
        {
          merchantId: merchant.id,
          candidateTransactionId: tx.id,
          orderPk: locked.id,
          possibleOrderIds: [locked.orderId],
          reason: 'AMOUNT_MISMATCH',
          detail: `Expected ${locked.amountPaise} paise, received ${candidate.amountPaise} paise`,
        },
        client,
      );
      if (['CREATED', 'PENDING', 'VERIFYING', 'EXPIRED'].includes(locked.status)) {
        await transitionOrder(client, {
          orderPk: locked.id,
          toStatus: 'REVIEW_REQUIRED',
          verificationStatus: 'REVIEW_REQUIRED',
          reasonCode: 'AMOUNT_MISMATCH',
          actorType: 'SYSTEM',
          note: `Received ${candidate.amountPaise} paise, expected ${locked.amountPaise} paise`,
          metadataPatch: { received_amount_paise: candidate.amountPaise },
        });
      }
      return { httpStatus: 200, outcome: 'REVIEW_REQUIRED' as const, eventId };
    }

    if (candidate.currency && candidate.currency !== locked.currency) {
      const tx = await recordCandidateTransaction(client, {
        candidate,
        merchantId: merchant.id,
        orderPk: locked.id,
        verificationStatus: 'REVIEW_REQUIRED',
        credited: false,
      });
      await ops.openReconciliationCase(
        {
          merchantId: merchant.id,
          candidateTransactionId: tx.id,
          orderPk: locked.id,
          possibleOrderIds: [locked.orderId],
          reason: 'AMOUNT_MISMATCH',
          detail: `Currency mismatch: order ${locked.currency}, payment ${candidate.currency}`,
        },
        client,
      );
      return { httpStatus: 200, outcome: 'REVIEW_REQUIRED' as const, eventId };
    }

    // Payee account verification, where the provider exposes it.
    if (
      candidate.payeeVpa &&
      locked.upiPayeeVpa &&
      candidate.payeeVpa.toLowerCase() !== locked.upiPayeeVpa.toLowerCase()
    ) {
      const tx = await recordCandidateTransaction(client, {
        candidate,
        merchantId: merchant.id,
        orderPk: locked.id,
        verificationStatus: 'VERIFIED',
        credited: false,
      });
      await ops.openReconciliationCase(
        {
          merchantId: merchant.id,
          candidateTransactionId: tx.id,
          orderPk: locked.id,
          possibleOrderIds: [locked.orderId],
          reason: 'WRONG_MERCHANT',
          detail: 'Payment was made to a different UPI ID than the order payee',
        },
        client,
      );
      if (['CREATED', 'PENDING', 'VERIFYING', 'EXPIRED'].includes(locked.status)) {
        await transitionOrder(client, {
          orderPk: locked.id,
          toStatus: 'REVIEW_REQUIRED',
          verificationStatus: 'REVIEW_REQUIRED',
          reasonCode: 'PAYMENT_TO_WRONG_ACCOUNT',
          actorType: 'SYSTEM',
          note: 'Payment for this order was addressed to a different UPI ID',
        });
      }
      return { httpStatus: 200, outcome: 'REVIEW_REQUIRED' as const, eventId };
    }

    // A second successful payment for an order that already holds money.
    if (['PAID', 'LATE_PAYMENT', 'REFUND_PENDING', 'PARTIALLY_REFUNDED', 'REFUNDED'].includes(locked.status)) {
      const tx = await recordCandidateTransaction(client, {
        candidate,
        merchantId: merchant.id,
        orderPk: locked.id,
        verificationStatus: 'REVIEW_REQUIRED',
        credited: false,
      });
      await ops.openReconciliationCase(
        {
          merchantId: merchant.id,
          candidateTransactionId: tx.id,
          orderPk: locked.id,
          possibleOrderIds: [locked.orderId],
          reason: 'DUPLICATE_PAYMENT',
          detail: `Additional successful payment received for an order already marked ${locked.status}`,
        },
        client,
      );
      return { httpStatus: 200, outcome: 'REVIEW_REQUIRED' as const, eventId };
    }

    const late = isLate(locked, new Date());
    const targetStatus: OrderStatus =
      late || locked.status === 'EXPIRED' ? 'LATE_PAYMENT' : 'PAID';

    const paidAt = candidate.paidAt ?? new Date();
    const tx = await recordCandidateTransaction(client, {
      candidate,
      merchantId: merchant.id,
      orderPk: locked.id,
      verificationStatus: 'VERIFIED',
      credited: true,
      verifiedAt: new Date(),
      paidAt,
    });

    const updated = await transitionOrder(client, {
      orderPk: locked.id,
      toStatus: targetStatus,
      verificationStatus: 'VERIFIED',
      verificationSource,
      paidAt,
      paidAmountPaise: candidate.amountPaise ?? locked.amountPaise,
      reasonCode: targetStatus === 'LATE_PAYMENT' ? 'LATE_PAYMENT_CONFIRMED' : 'PAYMENT_CONFIRMED',
      actorType: 'PROVIDER',
      note: `transaction ${tx.providerTransactionReference} via ${candidate.providerName}`,
      metadataPatch: {
        verified_by: verificationSource,
        provider_transaction_reference: candidate.providerTransactionReference,
      },
    });

    if (targetStatus === 'LATE_PAYMENT') {
      await ops.openReconciliationCase(
        {
          merchantId: merchant.id,
          candidateTransactionId: tx.id,
          orderPk: locked.id,
          possibleOrderIds: [locked.orderId],
          reason: 'LATE_PAYMENT',
          detail: `Confirmed payment arrived after expiry (merchant policy: ${merchant.latePaymentPolicy})`,
        },
        client,
      );
    }

    // A late payment stays open for merchant acknowledgement: the money arrived,
    // but fulfilment/refund is a human decision.
    if (targetStatus !== 'LATE_PAYMENT') {
      await resolveCasesForTransaction(
        client,
        tx.id,
        'RESOLVED_PAID',
        'Auto-resolved: authoritative confirmation received',
      );
    }
    await ops.writeAudit(
      {
        actorId: null,
        actorType: 'PROVIDER',
        action: targetStatus === 'PAID' ? 'ORDER_PAID' : 'ORDER_LATE_PAYMENT',
        resourceType: 'payment_order',
        resourceId: updated.orderId,
        metadata: {
          provider: candidate.providerName,
          reference: candidate.providerTransactionReference,
          source: verificationSource,
          amount_paise: updated.paidAmountPaise,
        },
        ipHash: args.ipHash ?? null,
      },
      client,
    );
    return { httpStatus: 200, outcome: 'PROCESSED' as const, eventId };
  });
}

// ---------------------------------------------------------------------------
// failure / pending / reversal
// ---------------------------------------------------------------------------

async function applyAuthoritativeFailure(args: ApplyArgs & { order: Order }): Promise<IngestResult> {
  const { candidate, order, merchant, eventId } = args;
  return withTransaction(async (client) => {
    const locked = await orderRepo.lockOrderForUpdate(client, order.id);
    if (!locked) throw new AppError('NOT_FOUND', 'Order not found', 404);

    const tx = await recordCandidateTransaction(client, {
      candidate,
      merchantId: merchant.id,
      orderPk: locked.id,
      verificationStatus: 'VERIFIED',
      credited: false,
    });

    if (['CREATED', 'PENDING', 'VERIFYING'].includes(locked.status)) {
      await transitionOrder(client, {
        orderPk: locked.id,
        toStatus: 'FAILED',
        verificationStatus: 'VERIFICATION_FAILED',
        reasonCode: 'PROVIDER_REPORTED_FAILURE',
        actorType: 'PROVIDER',
        note: candidate.failureReason?.slice(0, 300) ?? null,
      });
    } else if (['PAID', 'LATE_PAYMENT', 'PARTIALLY_REFUNDED'].includes(locked.status)) {
      // Contradictory evidence: never regress a paid order automatically.
      await ops.openReconciliationCase(
        {
          merchantId: merchant.id,
          candidateTransactionId: tx.id,
          orderPk: locked.id,
          possibleOrderIds: [locked.orderId],
          reason: 'OTHER',
          detail: 'Provider reported a failure for an order that is already marked paid',
        },
        client,
      );
    }
    await ops.writeAudit(
      {
        actorId: null,
        actorType: 'PROVIDER',
        action: 'PAYMENT_FAILED',
        resourceType: 'payment_order',
        resourceId: locked.orderId,
        metadata: { provider: candidate.providerName, reference: candidate.providerTransactionReference },
        ipHash: args.ipHash ?? null,
      },
      client,
    );
    return { httpStatus: 200, outcome: 'PROCESSED' as const, eventId };
  });
}

async function applyAuthoritativePending(args: ApplyArgs & { order: Order }): Promise<IngestResult> {
  const { candidate, order, merchant, eventId } = args;
  return withTransaction(async (client) => {
    const locked = await orderRepo.lockOrderForUpdate(client, order.id);
    if (!locked) throw new AppError('NOT_FOUND', 'Order not found', 404);
    await recordCandidateTransaction(client, {
      candidate,
      merchantId: merchant.id,
      orderPk: locked.id,
      verificationStatus: 'PENDING_AUTHORITATIVE',
      credited: false,
    });
    if (locked.status === 'PENDING' || locked.status === 'CREATED') {
      await transitionOrder(client, {
        orderPk: locked.id,
        toStatus: 'VERIFYING',
        verificationStatus: 'PENDING_AUTHORITATIVE',
        reasonCode: 'PROVIDER_REPORTED_PENDING',
        actorType: 'PROVIDER',
      });
    }
    return { httpStatus: 200, outcome: 'PROCESSED' as const, eventId };
  });
}

async function applyReversal(args: ApplyArgs & { order: Order }): Promise<IngestResult> {
  const { candidate, order, merchant, eventId } = args;
  return withTransaction(async (client) => {
    const locked = await orderRepo.lockOrderForUpdate(client, order.id);
    if (!locked) throw new AppError('NOT_FOUND', 'Order not found', 404);

    // Undo the ledger credit before recording the reversal. The original credit
    // stays visible in the status history and audit log; the order itself is
    // escalated to review rather than silently un-paid.
    if (candidate.providerTransactionReference) {
      const credited = await findTxForUpdate(
        client,
        candidate.providerName,
        candidate.providerTransactionReference,
      );
      if (credited?.creditedToOrder) {
        await ledger.updateTransaction(client, credited.id, {
          creditedToOrder: false,
          transactionStatus: 'REVERSED',
        });
      }
    }

    const tx = await recordCandidateTransaction(client, {
      candidate,
      merchantId: merchant.id,
      orderPk: locked.id,
      verificationStatus: 'VERIFIED',
      credited: false,
    });
    await ops.openReconciliationCase(
      {
        merchantId: merchant.id,
        candidateTransactionId: tx.id,
        orderPk: locked.id,
        possibleOrderIds: [locked.orderId],
        reason: 'TRANSACTION_REVERSED',
        detail: `Provider reported status ${candidate.status}; refund/reversal handling required`,
      },
      client,
    );
    if (['PAID', 'LATE_PAYMENT', 'PARTIALLY_REFUNDED'].includes(locked.status)) {
      await transitionOrder(client, {
        orderPk: locked.id,
        toStatus: 'REVIEW_REQUIRED',
        verificationStatus: 'REVIEW_REQUIRED',
        reasonCode: 'TRANSACTION_REVERSED',
        actorType: 'PROVIDER',
      });
    }
    return { httpStatus: 200, outcome: 'REVIEW_REQUIRED' as const, eventId };
  });
}

async function applyUnknown(args: ApplyArgs & { order: Order }): Promise<IngestResult> {
  const { candidate, order, merchant, eventId } = args;
  return withTransaction(async (client) => {
    const tx = await recordCandidateTransaction(client, {
      candidate,
      merchantId: merchant.id,
      orderPk: order.id,
      verificationStatus: 'REVIEW_REQUIRED',
      credited: false,
    });
    await ops.openReconciliationCase(
      {
        merchantId: merchant.id,
        candidateTransactionId: tx.id,
        orderPk: order.id,
        possibleOrderIds: [order.orderId],
        reason: 'OTHER',
        detail: 'Provider returned an unrecognised payment status',
      },
      client,
    );
    return { httpStatus: 200, outcome: 'REVIEW_REQUIRED' as const, eventId };
  });
}

// ---------------------------------------------------------------------------
// transaction persistence helpers
// ---------------------------------------------------------------------------

export async function recordCandidateTransaction(
  client: PoolClient,
  input: {
    candidate: NormalizedCandidate;
    merchantId: string;
    orderPk: string | null;
    verificationStatus: 'UNVERIFIED' | 'PENDING_AUTHORITATIVE' | 'VERIFIED' | 'VERIFICATION_FAILED' | 'REVIEW_REQUIRED';
    credited: boolean;
    verifiedAt?: Date | null;
    paidAt?: Date | null;
  },
): Promise<{ id: string; providerTransactionReference: string; verificationStatus: string }> {
  const { candidate } = input;
  const reference = ensureReference(candidate, input.orderPk);
  const existing = await findTxForUpdate(client, candidate.providerName, reference);

  const fields = {
    providerName: candidate.providerName,
    providerTransactionReference: reference,
    providerPaymentId: candidate.providerPaymentId,
    orderPk: input.orderPk,
    merchantId: input.merchantId,
    amountPaise: candidate.amountPaise ?? 0,
    currency: candidate.currency || 'INR',
    transactionStatus: candidate.status,
    verificationStatus: input.verificationStatus,
    source: candidate.source,
    candidateFingerprint: candidate.source === 'GMAIL_NOTIFICATION' ? fingerprint(candidate) : null,
    payeeVpa: candidate.payeeVpa,
    payerReference: null,
    transactionTimestamp: candidate.paidAt ?? new Date(),
    verifiedAt: input.verificationStatus === 'VERIFIED' ? (input.verifiedAt ?? new Date()) : null,
    creditedToOrder: input.credited,
    rawEvidence: {
      event_id: candidate.eventId,
      failure_reason: candidate.failureReason,
      ...sanitizeRaw(candidate.raw),
    },
  };

  if (existing) {
    // Keep the strongest verification state: never downgrade VERIFIED.
    const verification =
      existing.verificationStatus === 'VERIFIED' && fields.verificationStatus !== 'VERIFIED'
        ? 'VERIFIED'
        : fields.verificationStatus;
    const updated = await ledger.updateTransaction(client, existing.id, {
      orderPk: input.orderPk ?? existing.orderPk,
      transactionStatus: fields.transactionStatus,
      verificationStatus: verification,
      source: fields.source,
      verifiedAt: fields.verifiedAt ?? existing.verifiedAt,
      creditedToOrder: existing.creditedToOrder || input.credited,
      providerPaymentId: fields.providerPaymentId ?? existing.providerPaymentId,
      payeeVpa: fields.payeeVpa ?? existing.payeeVpa,
      rawEvidence: { ...existing.rawEvidence, ...fields.rawEvidence },
    });
    return {
      id: updated.id,
      providerTransactionReference: updated.providerTransactionReference,
      verificationStatus: updated.verificationStatus,
    };
  }

  if (!candidate.amountPaise || candidate.amountPaise <= 0) {
    throw new AppError('VALIDATION_ERROR', 'Transaction has no usable amount', 422);
  }

  try {
    const inserted = await ledger.insertTransaction(client, fields);
    return {
      id: inserted.id,
      providerTransactionReference: inserted.providerTransactionReference,
      verificationStatus: inserted.verificationStatus,
    };
  } catch (err) {
    // Concurrent insert of the same reference: fall back to updating the winner.
    if (typeof err === 'object' && err !== null && (err as { code?: string }).code === '23505') {
      const winner = await findTxForUpdate(client, candidate.providerName, reference);
      if (!winner) throw err;
      return {
        id: winner.id,
        providerTransactionReference: winner.providerTransactionReference,
        verificationStatus: winner.verificationStatus,
      };
    }
    throw err;
  }
}

async function findTxForUpdate(
  client: PoolClient,
  providerName: string,
  reference: string,
): Promise<Awaited<ReturnType<typeof ledger.findTransactionByProviderReference>> | null> {
  const res = await client.query<{
    id: string;
    provider_transaction_reference: string;
    order_id: string | null;
    verification_status: string;
    credited_to_order: boolean;
    raw_evidence: Record<string, unknown>;
    provider_payment_id: string | null;
    payee_vpa: string | null;
    verified_at: Date | null;
  }>(
    `SELECT id, provider_transaction_reference, order_id, verification_status, credited_to_order,
            raw_evidence, provider_payment_id, payee_vpa, verified_at
       FROM payment_transactions
      WHERE provider_name = $1 AND provider_transaction_reference = $2
      FOR UPDATE`,
    [providerName, reference],
  );
  const row = res.rows[0];
  if (!row) return null;
  return {
    id: row.id,
    providerName,
    providerTransactionReference: row.provider_transaction_reference,
    providerPaymentId: row.provider_payment_id,
    orderPk: row.order_id,
    merchantId: '',
    amountPaise: 0,
    currency: 'INR',
    transactionStatus: 'UNKNOWN',
    verificationStatus: row.verification_status as
      | 'UNVERIFIED'
      | 'PENDING_AUTHORITATIVE'
      | 'VERIFIED'
      | 'VERIFICATION_FAILED'
      | 'REVIEW_REQUIRED',
    source: 'PROVIDER_WEBHOOK',
    candidateFingerprint: null,
    payeeVpa: row.payee_vpa,
    payerReference: null,
    transactionTimestamp: new Date(),
    verifiedAt: row.verified_at,
    creditedToOrder: row.credited_to_order,
    rawEvidence: row.raw_evidence ?? {},
    createdAt: new Date(),
  };
}

async function resolveCasesForTransaction(
  client: PoolClient,
  transactionId: string,
  resolution: 'RESOLVED_PAID' | 'RESOLVED_REJECTED',
  note: string,
): Promise<void> {
  await client.query(
    `UPDATE reconciliation_cases
        SET resolution_status = $2, resolution_note = $3, reviewed_at = now()
      WHERE candidate_transaction_id = $1 AND resolution_status = 'OPEN'`,
    [transactionId, resolution, note],
  );
}

// ---------------------------------------------------------------------------
// merchant resolution
// ---------------------------------------------------------------------------

export async function resolveMerchantForCandidate(
  candidate: NormalizedCandidate,
): Promise<Merchant | null> {
  if (candidate.internalOrderReference) {
    const order = await orderRepo.findOrderByOrderId(
      candidate.internalOrderReference.toUpperCase(),
    );
    if (order) return merchantRepo.findMerchantById(order.merchantId);
  }
  if (candidate.providerPaymentId) {
    const orders = await orderRepo.findOrdersByProviderPaymentId(
      candidate.providerName,
      candidate.providerPaymentId,
    );
    if (orders[0]) return merchantRepo.findMerchantById(orders[0].merchantId);
  }
  if (candidate.providerOrderReference) {
    const order = await orderRepo.findOrderByOrderId(candidate.providerOrderReference.toUpperCase());
    if (order) return merchantRepo.findMerchantById(order.merchantId);
  }
  // Fall back to provider account association, then to a single active merchant.
  const merchants = await merchantRepo.listMerchants();
  const active = merchants.filter((m) => m.accountStatus === 'ACTIVE');
  if (active.length === 1 && active[0]) return active[0];
  return null;
}

// ---------------------------------------------------------------------------
// provider status polling
// ---------------------------------------------------------------------------

export type VerifyResult =
  | { kind: 'CONFIRMED'; order: Order; statusResult: StatusResult }
  | { kind: 'FAILED'; order: Order; statusResult: StatusResult }
  | { kind: 'PENDING'; order: Order; statusResult: StatusResult }
  | { kind: 'NOT_SUPPORTED'; order: Order; reason: string }
  | { kind: 'UNAVAILABLE'; order: Order; reason: string };

/**
 * Asks the provider (not the browser, not an email) for the authoritative
 * status of an order, then applies the result through the same engine used by
 * webhooks.
 */
export async function verifyOrderWithProvider(
  order: Order,
  options: { trigger: 'CUSTOMER_CHECK' | 'RECONCILIATION' | 'GMAIL_TRIGGER'; ipHash?: string | null } = {
    trigger: 'RECONCILIATION',
  },
): Promise<VerifyResult> {
  const provider = tryGetProvider(order.providerName);
  if (!provider || !provider.capabilities.statusApi) {
    return {
      kind: 'NOT_SUPPORTED',
      order,
      reason: 'This payment method has no authorised status API; a human must reconcile it',
    };
  }
  if (!provider.isConfigured()) {
    return { kind: 'NOT_SUPPORTED', order, reason: 'Provider is not configured' };
  }
  if (!order.providerPaymentId) {
    return { kind: 'NOT_SUPPORTED', order, reason: 'Order has no provider payment reference' };
  }

  let statusResult: StatusResult;
  try {
    statusResult = await provider.getPaymentStatus({
      providerPaymentId: order.providerPaymentId,
      orderId: order.orderId,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Provider status call failed';
    getLogger().warn('provider status check failed', {
      provider: order.providerName,
      orderId: order.orderId,
      error: message,
    });
    return { kind: 'UNAVAILABLE', order, reason: message };
  }

  // The provider has no record yet (common in the first seconds after the
  // customer returns from their UPI app). Nothing to store, nothing to change.
  if (statusResult.status === 'PENDING' && statusResult.amountPaise === null) {
    return { kind: 'PENDING', order, statusResult };
  }

  const candidate: NormalizedCandidate = {
    providerName: order.providerName,
    providerTransactionReference: statusResult.providerTransactionReference
      ? normalizeReference(statusResult.providerTransactionReference)
      : null,
    providerPaymentId: statusResult.providerPaymentId,
    providerOrderReference: null,
    internalOrderReference: order.orderId,
    amountPaise: statusResult.amountPaise,
    currency: statusResult.currency || 'INR',
    status: providerStatusToTransactionStatus(statusResult.status),
    paidAt: statusResult.paidAt,
    payeeVpa: statusResult.payeeVpa,
    failureReason: statusResult.failureReason,
    source: 'PROVIDER_API',
    eventId: null,
    raw: {
      trigger: options.trigger,
      provider_payment_id: statusResult.providerPaymentId,
    },
  };

  const decision: MatchDecision = {
    outcome: 'LINKED',
    order,
    candidateOrders: [order],
    strategy: 'INTERNAL_REFERENCE',
    trusted: true,
    evidence: [`authoritative status check returned ${statusResult.status}`],
    reasons: [],
    existingOrder: null,
  };

  const merchant = await merchantRepo.findMerchantById(order.merchantId);
  if (!merchant) return { kind: 'NOT_SUPPORTED', order, reason: 'Merchant missing' };

  const result = await applyDecision({
    candidate,
    merchant,
    decision,
    eventId: null,
    ipHash: options.ipHash ?? null,
    verificationSource: 'PROVIDER_API',
  });

  const refreshed = (await orderRepo.findOrderByPk(order.id)) ?? order;
  if (result.outcome === 'REVIEW_REQUIRED') {
    return { kind: statusResult.status === 'FAILED' ? 'FAILED' : 'PENDING', order: refreshed, statusResult };
  }
  if (refreshed.status === 'PAID' || refreshed.status === 'LATE_PAYMENT') {
    return { kind: 'CONFIRMED', order: refreshed, statusResult };
  }
  if (refreshed.status === 'FAILED') {
    return { kind: 'FAILED', order: refreshed, statusResult };
  }
  return { kind: 'PENDING', order: refreshed, statusResult };
}

// ---------------------------------------------------------------------------
// utilities
// ---------------------------------------------------------------------------

export function providerStatusToTransactionStatus(status: ProviderPaymentStatus): TransactionStatus {
  switch (status) {
    case 'SUCCESS':
      return 'SUCCESS';
    case 'FAILED':
      return 'FAILED';
    case 'PENDING':
      return 'PENDING';
    case 'REVERSED':
      return 'REVERSED';
    case 'REFUNDED':
      return 'REFUNDED';
    default:
      return 'UNKNOWN';
  }
}

export function toMatchCandidate(candidate: NormalizedCandidate): MatchCandidate {
  return {
    providerName: candidate.providerName,
    providerTransactionReference: candidate.providerTransactionReference,
    providerPaymentId: candidate.providerPaymentId,
    providerOrderReference: candidate.providerOrderReference,
    internalOrderReference: candidate.internalOrderReference,
    amountPaise: candidate.amountPaise,
    currency: candidate.currency,
    transactionStatus: candidate.status,
    source: candidate.source,
    transactionTimestamp: candidate.paidAt ?? new Date(),
    payeeVpa: candidate.payeeVpa,
  };
}

/** Every transaction row needs a unique reference; synthesise one when absent. */
function ensureReference(candidate: NormalizedCandidate, orderPk: string | null): string {
  if (candidate.providerTransactionReference) return candidate.providerTransactionReference;
  const seed = [
    candidate.providerName,
    candidate.providerPaymentId ?? '',
    candidate.eventId ?? '',
    orderPk ?? '',
    candidate.amountPaise ?? '',
    (candidate.paidAt ?? new Date()).toISOString(),
  ].join('|');
  return `AUTO-${sha256(seed).slice(0, 24).toUpperCase()}`;
}

function fingerprint(candidate: NormalizedCandidate): string | null {
  // Only reference-bearing candidates get a fingerprint; without a reference two
  // genuine payments can be indistinguishable, and silently deduplicating them
  // would lose money evidence. Those go to review instead.
  if (!candidate.providerTransactionReference) return null;
  return sha256(
    [
      'gmail',
      candidate.providerName,
      candidate.providerTransactionReference,
      candidate.amountPaise ?? '',
      candidate.currency,
    ].join('|'),
  );
}

const SENSITIVE_KEYS = new Set([
  'email',
  'customer_email',
  'customer_phone',
  'contact',
  'phone',
  'customer_name',
  'name',
  'customer_details',
  'customer',
  'card',
  'vpa',
  'address',
  'billing_address',
  'shipping_address',
]);

/** Removes personal data from provider payloads before persisting them. */
export function sanitizeForStorage(value: unknown, depth = 0): Record<string, unknown> {
  if (depth > 6) return {};
  if (Array.isArray(value)) {
    // Preserve array shape so stored payloads remain re-parseable for retries.
    return value.slice(0, 20).map((v) => sanitizeForStorage(v, depth + 1)) as unknown as Record<string, unknown>;
  }
  if (!value || typeof value !== 'object') return {};
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (SENSITIVE_KEYS.has(k.toLowerCase())) {
      out[k] = '[redacted]';
    } else if (v && typeof v === 'object') {
      out[k] = sanitizeForStorage(v, depth + 1);
    } else if (typeof v === 'string') {
      out[k] = v.slice(0, 300);
    } else {
      out[k] = v;
    }
  }
  return out;
}

function sanitizeRaw(raw: Record<string, unknown>): Record<string, unknown> {
  return sanitizeForStorage(raw);
}

