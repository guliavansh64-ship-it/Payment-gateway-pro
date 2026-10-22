import { getConfig } from '../config';
import type { Order, ReconciliationReason } from '../domain/models';
import type { TransactionSource, TransactionStatus } from '../domain/status';
import { extractOrderId, isOrderIdFormat, normalizeOrderId } from '../domain/ids';
import * as orderRepo from '../repos/orders';
import * as ledger from '../repos/ledger';

/**
 * Transaction matching engine.
 *
 * The engine is deliberately conservative: it links a candidate transaction to
 * an order only when the evidence is strong, and it never uses amount and time
 * alone to *confirm* money. Anything weaker becomes a review case.
 *
 * Evidence ladder (strongest first):
 *   1. Our own order id echoed back by the provider (metadata / notes / order_id)
 *   2. Provider payment id stored on the order at creation time
 *   3. Provider transaction reference already linked to an order
 *   4. Unique UPI `tr` reference matching an order id
 *   5. Merchant verified VPA + exact amount + exactly one order in the window
 *   6. Exact amount + exactly one order in the window (weak; review only)
 */

export type MatchCandidate = {
  providerName: string;
  providerTransactionReference: string | null;
  providerPaymentId: string | null;
  providerOrderReference: string | null;
  internalOrderReference: string | null;
  amountPaise: number | null;
  currency: string;
  transactionStatus: TransactionStatus;
  source: TransactionSource;
  transactionTimestamp: Date;
  payeeVpa: string | null;
};

export type MatchStrategy =
  | 'INTERNAL_REFERENCE'
  | 'PROVIDER_PAYMENT_ID'
  | 'PROVIDER_REFERENCE'
  | 'UNIQUE_UPI_REFERENCE'
  | 'VPA_AMOUNT_TIME_UNIQUE'
  | 'AMOUNT_TIME_UNIQUE'
  | 'NONE';

export type MatchOutcome =
  | 'LINKED'
  | 'ALREADY_LINKED'
  | 'NO_ORDER'
  | 'AMBIGUOUS'
  | 'INSUFFICIENT_EVIDENCE'
  | 'CONFLICT';

export type MatchDecision = {
  outcome: MatchOutcome;
  order: Order | null;
  candidateOrders: Order[];
  strategy: MatchStrategy;
  /** True when the linkage evidence is strong enough to act without review. */
  trusted: boolean;
  evidence: string[];
  reasons: ReconciliationReason[];
  /** For ALREADY_LINKED: the order the transaction was already attached to. */
  existingOrder: Order | null;
};

const AWAITING_STATUSES = ['CREATED', 'PENDING', 'VERIFYING'] as const;

export async function matchTransaction(
  candidate: MatchCandidate,
  merchantId: string,
): Promise<MatchDecision> {
  const config = getConfig();
  const evidence: string[] = [];

  // 1. Our own order id echoed by the provider. Strongest possible evidence.
  if (candidate.internalOrderReference) {
    const normalized = normalizeOrderId(candidate.internalOrderReference);
    if (isOrderIdFormat(normalized)) {
      const order = await orderRepo.findOrderByOrderId(normalized);
      if (order) {
        evidence.push(`provider echoed internal order id ${order.orderId}`);
        return evaluateStrongOrder(order, candidate, merchantId, 'INTERNAL_REFERENCE', evidence);
      }
      evidence.push(`provider order reference ${normalized} does not exist locally`);
    }
  }

  // 2. Provider payment id attached to the order at creation.
  if (candidate.providerPaymentId) {
    const orders = await orderRepo.findOrdersByProviderPaymentId(
      candidate.providerName,
      candidate.providerPaymentId,
    );
    if (orders.length === 1 && orders[0]) {
      evidence.push(`provider payment id ${candidate.providerPaymentId} matches the order`);
      return evaluateStrongOrder(orders[0], candidate, merchantId, 'PROVIDER_PAYMENT_ID', evidence);
    }
    if (orders.length > 1) {
      return {
        outcome: 'AMBIGUOUS',
        order: null,
        candidateOrders: orders,
        strategy: 'PROVIDER_PAYMENT_ID',
        trusted: false,
        evidence: ['provider payment id matches multiple orders'],
        reasons: ['AMBIGUOUS_MATCH'],
        existingOrder: null,
      };
    }
  }

  // Cashfree-style: the provider order id IS our order id.
  if (candidate.providerOrderReference) {
    const normalized = normalizeOrderId(candidate.providerOrderReference);
    if (isOrderIdFormat(normalized)) {
      const order = await orderRepo.findOrderByOrderId(normalized);
      if (order) {
        evidence.push(`provider order reference ${normalized} matches an order`);
        return evaluateStrongOrder(order, candidate, merchantId, 'INTERNAL_REFERENCE', evidence);
      }
    }
  }

  // 3. Provider transaction reference already attached to an order.
  if (candidate.providerTransactionReference) {
    const existing = await ledger.findTransactionByProviderReference(
      candidate.providerName,
      candidate.providerTransactionReference,
    );
    if (existing?.orderPk) {
      const order = await orderRepo.findOrderByPk(existing.orderPk);
      if (order) {
        evidence.push(`transaction reference already linked to ${order.orderId}`);
        return {
          outcome: 'ALREADY_LINKED',
          order,
          candidateOrders: [order],
          strategy: 'PROVIDER_REFERENCE',
          trusted: true,
          evidence,
          reasons: ['DUPLICATE_PAYMENT'],
          existingOrder: order,
        };
      }
    }
    if (existing && !existing.orderPk) {
      evidence.push('transaction reference exists but is not linked to an order');
    }
    // UPI apps sometimes place our order id in the transaction reference.
    const asOrder = extractOrderId(candidate.providerTransactionReference);
    if (asOrder) {
      const order = await orderRepo.findOrderByOrderId(asOrder);
      if (order) {
        evidence.push(`UPI transaction reference contains order id ${order.orderId}`);
        return evaluateStrongOrder(order, candidate, merchantId, 'UNIQUE_UPI_REFERENCE', evidence);
      }
    }
  }

  // 4-6. Heuristic search inside a bounded window.
  if (!candidate.amountPaise || candidate.amountPaise <= 0) {
    return {
      outcome: 'NO_ORDER',
      order: null,
      candidateOrders: [],
      strategy: 'NONE',
      trusted: false,
      evidence: [...evidence, 'candidate has no usable amount'],
      reasons: ['MISSING_REFERENCE'],
      existingOrder: null,
    };
  }

  const windowStart = new Date(
    candidate.transactionTimestamp.getTime() - config.matchingWindowMinutes * 60_000,
  );
  const windowEnd = new Date(
    candidate.transactionTimestamp.getTime() + config.matchingWindowMinutes * 60_000,
  );
  const candidates = await orderRepo.findMatchingCandidates({
    merchantId,
    amountPaise: candidate.amountPaise,
    currency: candidate.currency,
    windowStart,
    windowEnd,
    statuses: [...AWAITING_STATUSES, 'EXPIRED', 'REVIEW_REQUIRED'],
  });

  if (candidates.length === 0) {
    return {
      outcome: 'NO_ORDER',
      order: null,
      candidateOrders: [],
      strategy: 'NONE',
      trusted: false,
      evidence: [...evidence, 'no order with the same amount inside the matching window'],
      reasons: ['MISSING_REFERENCE'],
      existingOrder: null,
    };
  }

  if (candidates.length > 1) {
    return {
      outcome: 'AMBIGUOUS',
      order: null,
      candidateOrders: candidates,
      strategy: 'AMOUNT_TIME_UNIQUE',
      trusted: false,
      evidence: [
        ...evidence,
        `${candidates.length} orders share the amount ${candidate.amountPaise} paise in the window`,
      ],
      reasons: ['AMBIGUOUS_MATCH'],
      existingOrder: null,
    };
  }

  const only = candidates[0] as Order;

  // Merchant identity mismatch is never auto-resolved.
  if (only.merchantId !== merchantId) {
    return {
      outcome: 'CONFLICT',
      order: only,
      candidateOrders: [only],
      strategy: 'AMOUNT_TIME_UNIQUE',
      trusted: false,
      evidence: [...evidence, 'candidate merchant does not match the order merchant'],
      reasons: ['WRONG_MERCHANT'],
      existingOrder: null,
    };
  }

  // A verified payee VPA on the candidate strengthens the match considerably.
  const vpaMatches =
    Boolean(candidate.payeeVpa) &&
    Boolean(only.upiPayeeVpa) &&
    candidate.payeeVpa!.toLowerCase() === only.upiPayeeVpa!.toLowerCase();
  if (vpaMatches) {
    evidence.push(`payee VPA ${maskVpa(candidate.payeeVpa!)} matches the merchant's verified VPA`);
  }

  // Amount + time alone is explicitly not enough to *act*; only review.
  return {
    outcome: 'INSUFFICIENT_EVIDENCE',
    order: only,
    candidateOrders: [only],
    strategy: vpaMatches ? 'VPA_AMOUNT_TIME_UNIQUE' : 'AMOUNT_TIME_UNIQUE',
    trusted: false,
    evidence: [
      ...evidence,
      `single order ${only.orderId} matches amount and window, but no provider-side reference ties the payment to it`,
    ],
    reasons: ['MISSING_REFERENCE'],
    existingOrder: null,
  };
}

/**
 * A strong reference matched an order. Validate that the order actually belongs
 * to the merchant we associated the payment with and that the order is real.
 */
function evaluateStrongOrder(
  order: Order,
  candidate: MatchCandidate,
  merchantId: string,
  strategy: MatchStrategy,
  evidence: string[],
): MatchDecision {
  if (order.merchantId !== merchantId) {
    return {
      outcome: 'CONFLICT',
      order,
      candidateOrders: [order],
      strategy,
      trusted: false,
      evidence: [...evidence, 'order belongs to a different merchant'],
      reasons: ['WRONG_MERCHANT'],
      existingOrder: null,
    };
  }
  if (order.status === 'PAID' || order.status === 'LATE_PAYMENT') {
    return {
      outcome: 'ALREADY_LINKED',
      order,
      candidateOrders: [order],
      strategy,
      trusted: true,
      evidence: [...evidence, `order is already ${order.status}`],
      reasons: ['DUPLICATE_PAYMENT'],
      existingOrder: order,
    };
  }
  return {
    outcome: 'LINKED',
    order,
    candidateOrders: [order],
    strategy,
    trusted: true,
    evidence,
    reasons: [],
    existingOrder: null,
  };
}

/** Logs show VPAs partially masked; full VPAs stay in the database only. */
export function maskVpa(vpa: string): string {
  const [user, host] = vpa.split('@');
  if (!user || !host) return '***';
  const visible = user.slice(0, 2);
  return `${visible}${'*'.repeat(Math.max(1, user.length - 2))}@${host}`;
}
