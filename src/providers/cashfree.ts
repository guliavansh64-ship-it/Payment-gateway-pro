import { getConfig } from '../config';
import { ProviderError, WebhookSignatureError } from '../errors';
import { formatPaise } from '../domain/money';
import { hmacSha256 } from '../security/crypto';
import { requestJson } from './http';
import {
  mapStatus,
  type CreatePaymentInput,
  type CreatePaymentResult,
  type NormalizedWebhook,
  type PaymentProvider,
  type ProviderHealth,
  type RefundInput,
  type RefundResult,
  type StatusQuery,
  type StatusResult,
  type WebhookVerification,
} from './types';
import { headerValue } from './razorpay';

/**
 * Cashfree adapter — Payment Gateway (PG) API.
 *
 * Integration status: IMPLEMENTED, NOT VERIFIED IN THIS REPOSITORY.
 * Validate against the Cashfree sandbox before enabling (docs/PROVIDER_ONBOARDING.md).
 *
 * Documented APIs used (x-api-version: 2023-08-01):
 *   POST /pg/orders                        create an order (hosted checkout)
 *   GET  /pg/orders/{order_id}             order status
 *   GET  /pg/orders/{order_id}/payments    payment attempts, UTR / bank reference
 *   POST /pg/orders/{order_id}/refunds     refunds
 * Webhook authentication:
 *   signature = base64(HMAC-SHA256(secret, x-webhook-timestamp + rawBody))
 *   sent as `x-webhook-signature`, with `x-webhook-timestamp` (unix seconds).
 *   Cashfree documents a 5-minute timestamp tolerance: enforced here.
 *
 * Note on UPI QR: Cashfree's UPI QR is rendered by their checkout SDK. This
 * adapter creates an order and returns the checkout URL; it does not fabricate
 * a UPI intent URI of its own.
 */

const HOSTS = {
  sandbox: 'https://sandbox.cashfree.com/pg',
  production: 'https://api.cashfree.com/pg',
};

const API_VERSION = '2023-08-01';
const TIMESTAMP_TOLERANCE_SECONDS = 300;

type CashfreeOrder = {
  cf_order_id?: string | number;
  order_id?: string;
  order_status?: string;
  order_amount?: number;
  payment_session_id?: string;
  order_expiry_time?: string;
  order_note?: string;
};

type CashfreePayment = {
  cf_payment_id?: string | number;
  payment_status?: string;
  payment_amount?: number;
  payment_currency?: string;
  payment_time?: string;
  bank_reference?: string | null;
  payment_group?: string;
  payment_method?: {
    upi?: { upi_id?: string | null; channel?: string | null };
  } | null;
  payment_message?: string | null;
  order_id?: string;
};

function baseUrl(): string {
  return HOSTS[getConfig().cashfree.mode];
}

function headers(extra: Record<string, string> = {}): Record<string, string> {
  const { clientId, clientSecret } = getConfig().cashfree;
  if (!clientId || !clientSecret) {
    throw new ProviderError('cashfree', 'not_configured', 'Cashfree credentials are not configured');
  }
  return {
    'x-client-id': clientId,
    'x-client-secret': clientSecret,
    'x-api-version': API_VERSION,
    ...extra,
  };
}

/**
 * Cashfree expects `order_amount` as a JSON number of rupees. We hand JSON a
 * number derived from the exact decimal string; JSON.stringify reproduces the
 * shortest round-tripping decimal, so 49910 paise -> 499.1 -> parsed as 499.10.
 * Amounts are additionally range-checked before we ever reach this point.
 */
function paiseToCashfreeAmount(paise: number): number {
  const value = Number(formatPaise(paise));
  if (!Number.isFinite(value) || value <= 0) {
    throw new ProviderError('cashfree', 'validation', 'Invalid amount for Cashfree');
  }
  return value;
}

function cashfreeAmountToPaise(amount: number | undefined | null): number | null {
  if (amount === null || amount === undefined) return null;
  const paise = Math.round(amount * 100);
  if (!Number.isSafeInteger(paise) || paise <= 0) return null;
  return paise;
}

export class CashfreeProvider implements PaymentProvider {
  readonly name = 'cashfree';
  readonly displayName = 'Cashfree';
  readonly capabilities = {
    dynamicQr: false, // UPI QR is rendered inside Cashfree's checkout
    paymentRequest: true,
    statusApi: true,
    webhooks: true,
    refunds: true,
    reconciliation: false,
    simulated: false,
  } as const;

  private readonly fetchImpl?: typeof fetch;

  constructor(fetchImpl?: typeof fetch) {
    this.fetchImpl = fetchImpl;
  }

  isConfigured(): boolean {
    const c = getConfig().cashfree;
    return Boolean(c.clientId && c.clientSecret && c.webhookSecret);
  }

  async createPayment(input: CreatePaymentInput): Promise<CreatePaymentResult> {
    if (!this.isConfigured()) {
      throw new ProviderError('cashfree', 'not_configured', 'Cashfree is not configured');
    }
    const body = {
      // Cashfree requires an alphanumeric order id; our order id already is.
      order_id: input.orderId,
      order_amount: paiseToCashfreeAmount(input.amountPaise),
      order_currency: 'INR',
      order_note: (input.description ?? `Payment for ${input.orderId}`).slice(0, 200),
      order_expiry_time: input.expiresAt.toISOString(),
      customer_details: {
        // Cashfree requires a customer id; this is a non-personal synthetic id.
        customer_id: input.customerReference ?? `anon-${input.orderId.slice(-8)}`,
        customer_phone: '9999999999',
      },
      order_meta: {
        return_url: `${getConfig().appUrl}/pay/return`,
      },
    };
    const res = await requestJson<CashfreeOrder>({
      provider: 'cashfree',
      method: 'POST',
      url: `${baseUrl()}/orders`,
      headers: headers({ 'x-idempotency-key': `order-${input.orderId}` }),
      body,
      timeoutMs: 15_000,
      fetchImpl: this.fetchImpl,
    });
    if (res.status >= 400 || !res.body?.cf_order_id) {
      throw new ProviderError('cashfree', 'validation', 'Cashfree rejected the order request', {
        details: { status: res.status },
      });
    }
    return {
      providerPaymentId: String(res.body.cf_order_id),
      qrPayload: null,
      // Cashfree checkout is opened with the payment_session_id via their SDK.
      checkoutUrl: null,
      upiVpa: null,
      expiresAt: input.expiresAt,
      raw: {
        cfOrderId: String(res.body.cf_order_id),
        hasSession: Boolean(res.body.payment_session_id),
      },
    };
  }

  async getPaymentStatus(query: StatusQuery): Promise<StatusResult> {
    const orderRes = await requestJson<CashfreeOrder>({
      provider: 'cashfree',
      method: 'GET',
      url: `${baseUrl()}/orders/${encodeURIComponent(query.orderId)}`,
      headers: headers(),
      idempotent: true,
      fetchImpl: this.fetchImpl,
    });
    if (orderRes.status === 404) {
      throw new ProviderError('cashfree', 'validation', 'Order not found at Cashfree');
    }
    if (orderRes.status >= 400 || !orderRes.body?.order_id) {
      throw new ProviderError('cashfree', 'malformed_response', 'Unexpected Cashfree order response');
    }

    const paymentsRes = await requestJson<CashfreePayment[]>({
      provider: 'cashfree',
      method: 'GET',
      url: `${baseUrl()}/orders/${encodeURIComponent(query.orderId)}/payments`,
      headers: headers(),
      idempotent: true,
      fetchImpl: this.fetchImpl,
    });
    const payments = Array.isArray(paymentsRes.body) ? paymentsRes.body : [];
    const success = payments.find((p) => mapStatus(p.payment_status) === 'SUCCESS');
    const failed = payments.find((p) => mapStatus(p.payment_status) === 'FAILED');
    const chosen = success ?? failed;

    const orderStatus = mapStatus(orderRes.body.order_status);
    return {
      status: success ? 'SUCCESS' : chosen ? mapStatus(chosen.payment_status) : orderStatus,
      providerPaymentId: query.providerPaymentId,
      providerTransactionReference:
        (success?.bank_reference && success.bank_reference.trim()) ||
        (success?.cf_payment_id ? String(success.cf_payment_id) : null),
      amountPaise:
        cashfreeAmountToPaise(success?.payment_amount) ??
        cashfreeAmountToPaise(orderRes.body.order_amount),
      currency: success?.payment_currency ?? 'INR',
      paidAt: success?.payment_time ? new Date(success.payment_time) : null,
      payeeVpa: success?.payment_method?.upi?.upi_id ?? null,
      failureReason: success ? null : (chosen?.payment_message ?? null),
      raw: {
        orderStatus: orderRes.body.order_status ?? null,
        paymentStatus: chosen?.payment_status ?? null,
        cfPaymentId: chosen?.cf_payment_id ?? null,
      },
    };
  }

  async verifyWebhook(
    rawBody: Buffer,
    headersIn: Record<string, string | string[] | undefined>,
  ): Promise<WebhookVerification> {
    const secret = getConfig().cashfree.webhookSecret;
    if (!secret) throw new ProviderError('cashfree', 'not_configured', 'Cashfree webhook secret missing');
    const signature = headerValue(headersIn, 'x-webhook-signature');
    const timestamp = headerValue(headersIn, 'x-webhook-timestamp');
    if (!signature || !timestamp) {
      throw new WebhookSignatureError('Missing Cashfree webhook signature headers');
    }
    const expected = hmacSha256(secret, `${timestamp}${rawBody.toString('utf8')}`).toString('base64');
    if (expected.length !== signature.length) throw new WebhookSignatureError();
    let diff = 0;
    for (let i = 0; i < expected.length; i += 1) diff |= expected.charCodeAt(i) ^ signature.charCodeAt(i);
    if (diff !== 0) throw new WebhookSignatureError();

    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(rawBody.toString('utf8')) as Record<string, unknown>;
    } catch {
      throw new ProviderError('cashfree', 'malformed_response', 'Webhook body is not valid JSON');
    }
    const ts = Number(timestamp);
    const fresh = Number.isFinite(ts) && Math.abs(Date.now() / 1000 - ts) <= TIMESTAMP_TOLERANCE_SECONDS;
    const data = (parsed.data ?? {}) as Record<string, unknown>;
    const order = (data.order ?? {}) as Record<string, unknown>;
    const payment = (data.payment ?? {}) as Record<string, unknown>;
    const eventId =
      (typeof payment.cf_payment_id === 'string' && payment.cf_payment_id) ||
      (typeof payment.cf_payment_id === 'number' && String(payment.cf_payment_id)) ||
      `${String(parsed.type ?? 'event')}:${String(order.order_id ?? 'unknown')}:${timestamp}`;
    return {
      eventId: `cashfree:${eventId}:${String(parsed.type ?? '')}`,
      eventType: String(parsed.type ?? 'unknown'),
      occurredAt: new Date(ts * 1000),
      signatureScheme: 'hmac-sha256-base64(timestamp+raw-body)',
      timestampFresh: fresh,
    };
  }

  parseWebhook(payload: Record<string, unknown>): NormalizedWebhook {
    const data = (payload.data ?? {}) as Record<string, unknown>;
    const order = (data.order ?? {}) as Record<string, unknown>;
    const payment = (data.payment ?? {}) as Record<string, unknown>;
    const customer = (data.customer_details ?? {}) as Record<string, unknown>;
    const upi = ((payment.payment_method as { upi?: { upi_id?: string } } | undefined)?.upi ?? {}) as {
      upi_id?: string;
    };
    const cfPaymentId =
      typeof payment.cf_payment_id === 'string' || typeof payment.cf_payment_id === 'number'
        ? String(payment.cf_payment_id)
        : null;
    return {
      eventId: '',
      eventType: String(payload.type ?? 'unknown'),
      providerPaymentId: typeof order.order_id === 'string' ? order.order_id : null,
      providerOrderReference: typeof order.order_id === 'string' ? order.order_id : null,
      providerTransactionReference:
        (typeof payment.bank_reference === 'string' && payment.bank_reference.trim()) || cfPaymentId,
      amountPaise: cashfreeAmountToPaise(
        typeof payment.payment_amount === 'number' ? payment.payment_amount : undefined,
      ),
      currency: typeof payment.payment_currency === 'string' ? payment.payment_currency : 'INR',
      status: mapStatus(typeof payment.payment_status === 'string' ? payment.payment_status : undefined),
      paidAt: typeof payment.payment_time === 'string' ? new Date(payment.payment_time) : null,
      payeeVpa: typeof upi.upi_id === 'string' ? upi.upi_id : null,
      failureReason: typeof payment.payment_message === 'string' ? payment.payment_message : null,
      internalOrderReference: typeof order.order_id === 'string' ? order.order_id : null,
      raw: {
        orderStatus: order.order_status ?? null,
        cfPaymentId,
        customerId: customer.customer_id ?? null,
        paymentGroup: payment.payment_group ?? null,
      },
    };
  }

  async refund(input: RefundInput): Promise<RefundResult> {
    const res = await requestJson<{ refund_id?: string | number; refund_status?: string }>({
      provider: 'cashfree',
      method: 'POST',
      url: `${baseUrl()}/orders/${encodeURIComponent(input.providerPaymentId)}/refunds`,
      headers: headers(),
      body: {
        refund_id: input.internalRefundId,
        refund_amount: paiseToCashfreeAmount(input.amountPaise),
        refund_note: input.reasonNote.slice(0, 200),
      },
      timeoutMs: 15_000,
      fetchImpl: this.fetchImpl,
    });
    if (res.status >= 400 || !res.body?.refund_id) {
      throw new ProviderError('cashfree', 'validation', 'Cashfree rejected the refund request', {
        details: { status: res.status },
      });
    }
    const status =
      res.body.refund_status === 'SUCCESS'
        ? 'PROCESSED'
        : res.body.refund_status === 'FAILED'
          ? 'FAILED'
          : 'PENDING';
    return {
      providerRefundId: String(res.body.refund_id),
      status,
      raw: { status: res.body.refund_status ?? null },
    };
  }

  async getRefundStatus(input: {
    providerRefundId: string;
    providerPaymentId: string;
  }): Promise<{ status: 'PENDING' | 'PROCESSED' | 'FAILED'; raw: Record<string, unknown> }> {
    const res = await requestJson<{ refund_status?: string }>({
      provider: 'cashfree',
      method: 'GET',
      url: `${baseUrl()}/orders/${encodeURIComponent(input.providerPaymentId)}/refunds/${encodeURIComponent(input.providerRefundId)}`,
      headers: headers(),
      idempotent: true,
      fetchImpl: this.fetchImpl,
    });
    if (res.status >= 400) {
      throw new ProviderError('cashfree', 'validation', 'Cashfree refund lookup failed');
    }
    const status =
      res.body?.refund_status === 'SUCCESS'
        ? 'PROCESSED'
        : res.body?.refund_status === 'FAILED'
          ? 'FAILED'
          : 'PENDING';
    return { status, raw: { status: res.body?.refund_status ?? null } };
  }

  async checkHealth(): Promise<ProviderHealth> {
    if (!this.isConfigured()) return { status: 'DOWN', detail: 'Credentials not configured' };
    try {
      // Fetching a non-existent order distinguishes auth (401) from a working
      // API (404 with an error body) without creating data.
      const res = await requestJson<unknown>({
        provider: 'cashfree',
        method: 'GET',
        url: `${baseUrl()}/orders/healthcheck-probe-000`,
        headers: headers(),
        timeoutMs: 8000,
        fetchImpl: this.fetchImpl,
      });
      if (res.status === 404) return { status: 'OK', detail: 'Authenticated API call succeeded' };
      return { status: 'DEGRADED', detail: `Unexpected status ${res.status}` };
    } catch (err) {
      return {
        status: err instanceof ProviderError && err.kind === 'auth' ? 'DOWN' : 'DEGRADED',
        detail: err instanceof Error ? err.message : 'Health check failed',
      };
    }
  }
}
