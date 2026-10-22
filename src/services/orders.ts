import type { PoolClient } from 'pg';
import { getConfig } from '../config';
import { withTransaction } from '../db/pool';
import { AppError } from '../errors';
import { generateOrderId, generatePublicToken, isOrderIdFormat, normalizeOrderId } from '../domain/ids';
import { MoneyError, parseRupeesToPaise, toPaise } from '../domain/money';
import type { Merchant, Order, PaymentMethod } from '../domain/models';
import {
  assertTransition,
  type OrderStatus,
  type TransactionSource,
  type VerificationStatus,
} from '../domain/status';
import { isValidVpa } from '../domain/upi';
import { getLogger } from '../observability/logger';
import * as merchantRepo from '../repos/merchants';
import * as orderRepo from '../repos/orders';
import { writeAudit } from '../repos/ops';
import { getProvider, tryGetProvider, assertProviderAllowed } from '../providers/registry';

export type CreateOrderInput = {
  merchantId: string;
  amountRupees?: string;
  amountPaise?: number;
  paymentMethod: PaymentMethod;
  providerName?: string;
  description?: string | null;
  customerReference?: string | null;
  expiresInMinutes?: number;
};

const MAX_DESCRIPTION = 200;
const MAX_CUSTOMER_REFERENCE = 80;

/**
 * Creates an order and its payment instructions.
 *
 * Ordering matters:
 *   1. validate merchant + amount on the server
 *   2. persist the order (CREATED) so it exists before anything is displayed
 *   3. ask the provider for a payment request (may fail — the order then stays
 *      CREATED/FAILED and the customer is told there is no payable instruction)
 *   4. persist the provider reference and instructions, move to PENDING
 *
 * The customer can never set or change amount, merchant or provider after this.
 */
export async function createOrder(
  input: CreateOrderInput,
  context: { actorId: string | null; ipHash?: string; actorType?: 'ADMIN' | 'USER' | 'SYSTEM' } = {
    actorId: null,
  },
): Promise<{ order: Order; merchant: Merchant }> {
  const config = getConfig();
  const merchant = await merchantRepo.findMerchantById(input.merchantId);
  if (!merchant) throw new AppError('NOT_FOUND', 'Merchant not found', 404);
  if (merchant.accountStatus !== 'ACTIVE') {
    throw new AppError('FORBIDDEN', 'Merchant account is not active', 403);
  }

  let amountPaise: number;
  try {
    amountPaise =
      input.amountPaise !== undefined
        ? toPaise(input.amountPaise)
        : toPaise(parseRupeesToPaise(parseRupeeInput(input.amountRupees)));
  } catch (err) {
    throw new AppError('VALIDATION_ERROR', err instanceof MoneyError ? err.message : 'Invalid amount', 400);
  }
  if (amountPaise > config.maxOrderAmountPaise) {
    throw new AppError(
      'VALIDATION_ERROR',
      `Amount exceeds the configured maximum of ₹${(config.maxOrderAmountPaise / 100).toFixed(2)}`,
      400,
    );
  }

  const providerName = input.providerName ?? merchant.defaultProvider ?? 'manual_upi';
  assertProviderAllowed(providerName);
  const provider = getProvider(providerName);

  const paymentMethod = input.paymentMethod;
  if (paymentMethod === 'UPI_ID' && providerName !== 'manual_upi') {
    throw new AppError('VALIDATION_ERROR', 'UPI_ID payments use the manual_upi provider', 400);
  }
  if (paymentMethod !== 'UPI_ID' && providerName === 'manual_upi' && !merchant.verifiedMerchantUpiId) {
    throw new AppError(
      'PROVIDER_NOT_CONFIGURED',
      'Merchant has no verified UPI ID, so direct UPI collection is unavailable',
      409,
    );
  }
  if (
    (paymentMethod === 'UPI_QR' || paymentMethod === 'UPI_INTENT') &&
    providerName === 'manual_upi' &&
    !isValidVpa(merchant.verifiedMerchantUpiId ?? '')
  ) {
    throw new AppError('PROVIDER_NOT_CONFIGURED', 'Merchant UPI ID is not verified', 409);
  }

  // Payment instructions must be payable at creation time. A provider that has
  // no creation support (manual_upi) is only valid with a verified VPA.
  const expiryMinutes = clamp(
    input.expiresInMinutes ?? config.defaultOrderExpiryMinutes,
    2,
    24 * 60,
  );
  const expiresAt = new Date(Date.now() + expiryMinutes * 60_000);

  const order = await withTransaction(async (client) => {
    // Generate + persist first, so the order exists even if the provider call
    // later fails. Retry on the (astronomically unlikely) id collision.
    let created: Order | null = null;
    for (let attempt = 0; attempt < 5 && !created; attempt += 1) {
      const orderId = generateOrderId();
      try {
        created = await orderRepo.insertOrder(client, {
          orderId,
          merchantId: merchant.id,
          amountPaise,
          currency: 'INR',
          paymentMethod,
          providerName,
          providerPaymentId: null,
          publicToken: generatePublicToken(),
          status: 'CREATED',
          verificationStatus: 'UNVERIFIED',
          upiPayeeVpa: merchant.verifiedMerchantUpiId,
          upiPayeeName: merchant.businessName,
          qrPayload: null,
          description: input.description?.slice(0, MAX_DESCRIPTION) ?? null,
          customerReference: input.customerReference?.slice(0, MAX_CUSTOMER_REFERENCE) ?? null,
          expiresAt,
          metadata: {
            created_via: context.actorType ?? 'SYSTEM',
            provider_mode: provider.capabilities.simulated ? 'sandbox' : 'live',
          },
        });
      } catch (err) {
        if (isUniqueViolation(err)) continue;
        throw err;
      }
    }
    if (!created) throw new AppError('INTERNAL', 'Could not allocate a unique order id', 500);

    await orderRepo.insertStatusHistory(client, {
      orderPk: created.id,
      fromStatus: null,
      toStatus: 'CREATED',
      reasonCode: 'ORDER_CREATED',
      actorType: context.actorType === 'ADMIN' || context.actorType === 'USER' ? 'USER' : 'SYSTEM',
      actorId: context.actorId,
    });
    return created;
  });

  // Provider interaction happens outside the DB transaction: a slow provider
  // must not hold a row lock, and a provider failure must not lose the order.
  let providerPaymentId: string | null = null;
  let qrPayload: string | null = null;
  let checkoutUrl: string | null = null;
  let providerError: string | null = null;
  try {
    const result = await provider.createPayment({
      orderId: order.orderId,
      amountPaise: order.amountPaise,
      currency: 'INR',
      description: order.description,
      customerReference: order.customerReference,
      merchant,
      expiresAt: order.expiresAt,
    });
    providerPaymentId = result.providerPaymentId;
    qrPayload = result.qrPayload;
    checkoutUrl = result.checkoutUrl;
  } catch (err) {
    providerError = err instanceof Error ? err.message : 'Provider request failed';
    getLogger().warn('provider payment request failed', {
      provider: providerName,
      orderId: order.orderId,
      error: providerError,
    });
  }

  return withTransaction(async (client) => {
    const locked = await orderRepo.lockOrderForUpdate(client, order.id);
    if (!locked) throw new AppError('NOT_FOUND', 'Order disappeared during creation', 500);

    if (providerError) {
      // No payable instruction exists: the order must not linger as PENDING.
      if (locked.status === 'CREATED') {
        await orderRepo.updateOrder(client, locked.id, {
          status: 'FAILED',
          metadata: { ...locked.metadata, provider_error: providerError.slice(0, 300) },
        });
        await orderRepo.insertStatusHistory(client, {
          orderPk: locked.id,
          fromStatus: 'CREATED',
          toStatus: 'FAILED',
          reasonCode: 'PROVIDER_REQUEST_FAILED',
          actorType: 'SYSTEM',
          note: providerError.slice(0, 300),
        });
      }
      await writeAudit(
        {
          actorId: context.actorId,
          actorType: context.actorType ?? 'SYSTEM',
          action: 'ORDER_PROVIDER_FAILED',
          resourceType: 'payment_order',
          resourceId: locked.orderId,
          metadata: { provider: providerName, error: providerError.slice(0, 200) },
          ipHash: context.ipHash ?? null,
        },
        client,
      );
      return { order: { ...locked, status: 'FAILED' as OrderStatus }, merchant };
    }

    const updated = await orderRepo.updateOrder(client, locked.id, {
      status: 'PENDING',
      verificationStatus: 'UNVERIFIED',
      providerPaymentId,
      qrPayload,
      metadata: checkoutUrl
        ? { ...locked.metadata, checkout_url: checkoutUrl }
        : locked.metadata,
    });
    await orderRepo.insertStatusHistory(client, {
      orderPk: locked.id,
      fromStatus: locked.status,
      toStatus: 'PENDING',
      reasonCode: 'PAYMENT_INSTRUCTIONS_ISSUED',
      actorType: 'SYSTEM',
      note: providerName,
    });
    await writeAudit(
      {
        actorId: context.actorId,
        actorType: context.actorType ?? 'SYSTEM',
        action: 'ORDER_CREATED',
        resourceType: 'payment_order',
        resourceId: updated.orderId,
        metadata: {
          amount_paise: updated.amountPaise,
          method: paymentMethod,
          provider: providerName,
          merchant: merchant.merchantCode,
        },
        ipHash: context.ipHash ?? null,
      },
      client,
    );
    return { order: updated, merchant };
  });
}

/**
 * The ONLY code path that mutates an order's status.
 * Locks the row, validates the transition, updates, and appends history.
 */
export async function transitionOrder(
  client: PoolClient,
  input: {
    orderPk: string;
    toStatus: OrderStatus;
    verificationStatus: VerificationStatus;
    verificationSource?: TransactionSource | null;
    paidAt?: Date | null;
    paidAmountPaise?: number | null;
    /** Applied in the same UPDATE so refund invariants hold atomically. */
    refundedPaise?: number;
    reasonCode: string;
    actorType: 'SYSTEM' | 'PROVIDER' | 'USER' | 'ADMIN';
    actorId?: string | null;
    note?: string | null;
    metadataPatch?: Record<string, unknown>;
  },
): Promise<Order> {
  const current = await orderRepo.lockOrderForUpdate(client, input.orderPk);
  if (!current) throw new AppError('NOT_FOUND', 'Order not found', 404);

  if (current.status !== input.toStatus) {
    try {
      assertTransition(current.status, input.toStatus);
    } catch {
      throw new AppError(
        'INVALID_STATE_TRANSITION',
        `Order ${current.orderId} cannot move from ${current.status} to ${input.toStatus}`,
        409,
      );
    }
  }

  const patch: orderRepo.OrderPatch = {
    status: input.toStatus,
    verificationStatus: input.verificationStatus,
  };
  if (input.verificationSource !== undefined) patch.verificationSource = input.verificationSource;
  if (input.paidAt !== undefined) patch.paidAt = input.paidAt;
  if (input.paidAmountPaise !== undefined) patch.paidAmountPaise = input.paidAmountPaise;
  if (input.refundedPaise !== undefined) patch.refundedPaise = input.refundedPaise;
  if (input.paidAt) patch.verifiedAt = input.paidAt;
  if (input.metadataPatch) patch.metadata = { ...current.metadata, ...input.metadataPatch };

  const updated = await orderRepo.updateOrder(client, current.id, patch);
  if (current.status !== input.toStatus) {
    await orderRepo.insertStatusHistory(client, {
      orderPk: current.id,
      fromStatus: current.status,
      toStatus: input.toStatus,
      reasonCode: input.reasonCode,
      actorType: input.actorType,
      actorId: input.actorId ?? null,
      note: input.note ?? null,
    });
  }
  return updated;
}

export async function getOrderForCustomer(
  orderIdOrToken: string,
): Promise<{ order: Order; merchant: Merchant } | null> {
  const normalized = normalizeOrderId(orderIdOrToken);
  const order = isOrderIdFormat(normalized)
    ? await orderRepo.findOrderByOrderId(normalized)
    : await orderRepo.findOrderByPublicToken(orderIdOrToken);
  if (!order) return null;
  const merchant = await merchantRepo.findMerchantById(order.merchantId);
  if (!merchant) return null;
  return { order, merchant };
}

export async function getOrderDetail(orderPk: string): Promise<{
  order: Order;
  merchant: Merchant;
  history: Awaited<ReturnType<typeof orderRepo.getStatusHistory>>;
  transactions: Awaited<ReturnType<typeof import('../repos/ledger').findTransactionsByOrder>>;
  events: Awaited<ReturnType<typeof import('../repos/ledger').listEventsForOrder>>;
  refunds: Awaited<ReturnType<typeof import('../repos/ops').listRefundsForOrder>>;
} | null> {
  const order = await orderRepo.findOrderByPk(orderPk);
  if (!order) return null;
  const merchant = await merchantRepo.findMerchantById(order.merchantId);
  if (!merchant) return null;
  const [history, transactions, events, refunds] = await Promise.all([
    orderRepo.getStatusHistory(order.id),
    import('../repos/ledger').then((m) => m.findTransactionsByOrder(order.id)),
    import('../repos/ledger').then((m) => m.listEventsForOrder(order.id)),
    import('../repos/ops').then((m) => m.listRefundsForOrder(order.id)),
  ]);
  return { order, merchant, history, transactions, events, refunds };
}

/** Merchant dashboard link the customer may use safely (read-only token). */
export function customerPaymentPath(order: Order): string {
  return `/pay/${order.orderId}?t=${encodeURIComponent(order.publicToken)}`;
}

function parseRupeeInput(value: string | undefined): string {
  if (!value || value.trim().length === 0) throw new MoneyError('Amount is required');
  return value;
}

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(Math.max(Math.trunc(value), min), max);
}

export function isUniqueViolation(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: string }).code === '23505';
}

export function merchantCanUseProvider(merchant: Merchant, providerName: string): boolean {
  const provider = tryGetProvider(providerName);
  if (!provider || !provider.isConfigured()) return false;
  if (providerName === 'manual_upi') return Boolean(merchant.verifiedMerchantUpiId);
  return provider.capabilities.paymentRequest;
}
