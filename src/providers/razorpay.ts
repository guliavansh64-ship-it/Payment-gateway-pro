import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import { getConfig } from '../config';
import { ProviderError, WebhookSignatureError } from '../errors';
import { hmacSha256Hex } from '../security/crypto';
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

/**
 * Razorpay adapter — UPI QR Codes.
 *
 * Integration status: IMPLEMENTED, NOT VERIFIED IN THIS REPOSITORY.
 * The endpoints below are Razorpay's documented APIs, but this code has not
 * been executed against Razorpay credentials. Complete
 * docs/PROVIDER_ONBOARDING.md against a Razorpay test account before enabling
 * the provider for real merchants.
 *
 * Documented APIs used:
 *   POST   /v1/qr_codes                       create a single-use, fixed-amount UPI QR
 *   GET    /v1/qr_codes/{id}                  QR status
 *   GET    /v1/qr_codes/{id}/payments         payments received on the QR (for the UTR)
 *   POST   /v1/payments/{id}/refund           refunds
 *   GET    /v1/payments?count=1               credential health check
 * Webhook authentication: HMAC-SHA256 hex over the raw request body with the
 * webhook secret, sent in `X-Razorpay-Signature`.
 */

const API_BASE = 'https://api.razorpay.com/v1';

type RazorpayQr = {
  id: string;
  entity?: string;
  image_url?: string;
  payment_amount?: number;
  close_by?: number;
  status?: string;
  notes?: Record<string, string>;
};

type RazorpayPayment = {
  id: string;
  entity?: string;
  amount?: number;
  currency?: string;
  status?: string;
  method?: string;
  order_id?: string | null;
  created_at?: number;
  notes?: Record<string, string>;
  acquirer_data?: Record<string, string | number | null>;
  error_description?: string | null;
  error_code?: string | null;
};

function basicAuth(): string {
  const { keyId, keySecret } = getConfig().razorpay;
  if (!keyId || !keySecret) {
    throw new ProviderError('razorpay', 'not_configured', 'Razorpay credentials are not configured');
  }
  return `Basic ${Buffer.from(`${keyId}:${keySecret}`).toString('base64')}`;
}

function headers(extra: Record<string, string> = {}): Record<string, string> {
  return { Authorization: basicAuth(), ...extra };
}

/** Extracts the bank/UPI reference, which is what we match across sources. */
function extractReference(payment: RazorpayPayment | undefined): string | null {
  if (!payment) return null;
  const acq = payment.acquirer_data ?? {};
  const candidates = [acq['upi_transaction_id'], acq['rrn'], acq['bank_transaction_id'], acq['utr']];
  for (const c of candidates) {
    if (typeof c === 'string' && c.trim().length > 0) return c.trim();
  }
  return null;
}

function toPaise(amount: number | undefined | null): number | null {
  if (amount === null || amount === undefined) return null;
  if (!Number.isSafeInteger(amount)) return null;
  return amount;
}

export class RazorpayProvider implements PaymentProvider {
  readonly name = 'razorpay';
  readonly displayName = 'Razorpay';
  readonly capabilities = {
    dynamicQr: true,
    paymentRequest: true,
    statusApi: true,
    webhooks: true,
    refunds: true,
    reconciliation: false,
    simulated: false,
  } as const;

  private fetchImpl?: typeof fetch;

  constructor(fetchImpl?: typeof fetch) {
    this.fetchImpl = fetchImpl;
  }

  isConfigured(): boolean {
    const c = getConfig().razorpay;
    return Boolean(c.keyId && c.keySecret && c.webhookSecret);
  }

  async createPayment(input: CreatePaymentInput): Promise<CreatePaymentResult> {
    if (!this.isConfigured()) {
      throw new ProviderError('razorpay', 'not_configured', 'Razorpay is not configured');
    }
    // `close_by` is a unix timestamp in seconds; Razorpay rejects values in the past.
    const closeBy = Math.max(Math.floor(input.expiresAt.getTime() / 1000), Math.floor(Date.now() / 1000) + 300);
    const res = await requestJson<RazorpayQr>({
      provider: 'razorpay',
      method: 'POST',
      url: `${API_BASE}/qr_codes`,
      headers: headers({ 'X-Razorpay-Idempotency-Key': `qr-${input.orderId}` }),
      body: {
        type: 'upi_qr',
        name: `${input.merchant.businessName} - ${input.orderId}`.slice(0, 60),
        usage: 'single_use',
        fixed_amount: true,
        // Razorpay expects paise as an integer, which is already our storage unit.
        payment_amount: input.amountPaise,
        description: input.description ?? `Payment for ${input.orderId}`,
        close_by: closeBy,
        notes: {
          order_id: input.orderId,
          merchant_code: input.merchant.merchantCode,
        },
      },
      timeoutMs: 15_000,
      fetchImpl: this.fetchImpl,
    });

    if (res.status >= 400 || !res.body?.id) {
      throw new ProviderError('razorpay', 'validation', 'Razorpay rejected the QR creation request', {
        details: sanitizeProviderError(res.body),
      });
    }

    return {
      providerPaymentId: res.body.id,
      // image_url is a provider-hosted QR image; the payment page proxies it so
      // that no third-party script or cookie reaches the customer.
      qrPayload: res.body.image_url ?? null,
      checkoutUrl: null,
      upiVpa: null,
      expiresAt: res.body.close_by ? new Date(res.body.close_by * 1000) : null,
      raw: { id: res.body.id, status: res.body.status ?? null },
    };
  }

  async getPaymentStatus(query: StatusQuery): Promise<StatusResult> {
    const qr = await requestJson<RazorpayQr>({
      provider: 'razorpay',
      method: 'GET',
      url: `${API_BASE}/qr_codes/${encodeURIComponent(query.providerPaymentId)}`,
      headers: headers(),
      idempotent: true,
      fetchImpl: this.fetchImpl,
    });
    if (qr.status === 404) {
      throw new ProviderError('razorpay', 'validation', 'QR code not found at Razorpay');
    }
    if (qr.status >= 400 || !qr.body?.id) {
      throw new ProviderError('razorpay', 'malformed_response', 'Unexpected Razorpay QR response');
    }

    // The QR entity only exposes aggregate status. A successful QR always has
    // at least one payment; fetch it for the authoritative amount and UTR.
    let payment: RazorpayPayment | undefined;
    const paymentsRes = await requestJson<{ items?: RazorpayPayment[] }>({
      provider: 'razorpay',
      method: 'GET',
      url: `${API_BASE}/qr_codes/${encodeURIComponent(query.providerPaymentId)}/payments?count=5`,
      headers: headers(),
      idempotent: true,
      fetchImpl: this.fetchImpl,
    }).catch((err) => {
      // A missing payments endpoint must not fabricate a status; the QR status
      // still gives an authoritative pending/paid signal.
      if (err instanceof ProviderError && err.kind === 'validation') return null;
      throw err;
    });
    payment = paymentsRes?.body?.items?.find((p) => p.status === 'captured' || p.status === 'authorized');

    const qrStatus = qr.body.status === 'closed' ? 'PENDING' : mapStatus(qr.body.status);
    const status = payment ? mapStatus(payment.status) : qrStatus;

    return {
      status,
      providerPaymentId: query.providerPaymentId,
      providerTransactionReference: extractReference(payment),
      amountPaise: toPaise(payment?.amount) ?? toPaise(qr.body.payment_amount),
      currency: payment?.currency ?? 'INR',
      paidAt: payment?.created_at ? new Date(payment.created_at * 1000) : null,
      payeeVpa: null,
      failureReason: payment?.error_description ?? null,
      raw: { qrStatus: qr.body.status ?? null, paymentId: payment?.id ?? null },
    };
  }

  async verifyWebhook(
    rawBody: Buffer,
    headersIn: Record<string, string | string[] | undefined>,
  ): Promise<WebhookVerification> {
    const secret = getConfig().razorpay.webhookSecret;
    if (!secret) throw new ProviderError('razorpay', 'not_configured', 'Razorpay webhook secret missing');
    const signature = headerValue(headersIn, 'x-razorpay-signature');
    if (!signature) throw new WebhookSignatureError('Missing X-Razorpay-Signature');
    const expected = hmacSha256Hex(secret, rawBody);
    // Constant-time compare on equal-length hex strings.
    if (!timingSafeHexEqual(expected, signature.trim().toLowerCase())) {
      throw new WebhookSignatureError();
    }
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(rawBody.toString('utf8')) as Record<string, unknown>;
    } catch {
      throw new ProviderError('razorpay', 'malformed_response', 'Webhook body is not valid JSON');
    }
    const createdAt = typeof parsed.created_at === 'number' ? parsed.created_at : null;
    // Razorpay does not sign a timestamp. Replay protection is the unique event
    // id plus rejecting events dated in the future.
    const timestampFresh = createdAt === null || createdAt <= Math.floor(Date.now() / 1000) + 300;
    return {
      eventId:
        headerValue(headersIn, 'x-razorpay-event-id') ??
        `razorpay:${String(parsed.event ?? 'unknown')}:${String(createdAt ?? '')}:${sha1Hex(rawBody)}`,
      eventType: String(parsed.event ?? 'unknown'),
      occurredAt: createdAt ? new Date(createdAt * 1000) : null,
      signatureScheme: 'hmac-sha256-hex(raw-body)',
      timestampFresh,
    };
  }

  parseWebhook(payload: Record<string, unknown>): NormalizedWebhook {
    const event = String(payload.event ?? 'unknown');
    const payloadObj = (payload.payload ?? {}) as Record<string, unknown>;
    const paymentEntity = (
      (payloadObj.payment as { entity?: RazorpayPayment } | undefined)?.entity ?? undefined
    ) as RazorpayPayment | undefined;
    const qrEntity = (payloadObj.qr_code as { entity?: RazorpayQr } | undefined)?.entity;
    const linkEntity = (payloadObj.payment_link as { entity?: { id?: string; reference_id?: string } } | undefined)
      ?.entity;

    const payment = paymentEntity;
    const notes = payment?.notes ?? qrEntity?.notes ?? {};
    return {
      eventId: String(payload.event_id ?? ''),
      eventType: event,
      providerPaymentId: qrEntity?.id ?? payment?.order_id ?? payment?.id ?? linkEntity?.id ?? null,
      providerOrderReference: payment?.order_id ?? null,
      providerTransactionReference: extractReference(payment),
      amountPaise: toPaise(payment?.amount),
      currency: payment?.currency ?? 'INR',
      status: mapStatus(payment?.status ?? event.split('.').pop()),
      paidAt: payment?.created_at ? new Date(payment.created_at * 1000) : null,
      payeeVpa: null,
      failureReason: payment?.error_description ?? null,
      internalOrderReference: notes['order_id'] ?? linkEntity?.reference_id ?? null,
      raw: {
        event,
        paymentId: payment?.id ?? null,
        method: payment?.method ?? null,
        errorCode: payment?.error_code ?? null,
      },
    };
  }

  async refund(input: RefundInput): Promise<RefundResult> {
    const res = await requestJson<{ id?: string; status?: string }>({
      provider: 'razorpay',
      method: 'POST',
      url: `${API_BASE}/payments/${encodeURIComponent(input.providerPaymentId)}/refund`,
      headers: headers(),
      body: {
        amount: input.amountPaise,
        speed: 'normal',
        notes: { reason: input.reasonNote.slice(0, 200) },
        receipt: input.internalRefundId,
      },
      timeoutMs: 15_000,
      fetchImpl: this.fetchImpl,
    });
    if (res.status >= 400 || !res.body?.id) {
      throw new ProviderError('razorpay', 'validation', 'Razorpay rejected the refund request', {
        details: sanitizeProviderError(res.body),
      });
    }
    const status = res.body.status === 'processed' ? 'PROCESSED' : res.body.status === 'failed' ? 'FAILED' : 'PENDING';
    return { providerRefundId: res.body.id, status, raw: { status: res.body.status ?? null } };
  }

  async getRefundStatus(input: {
    providerRefundId: string;
    providerPaymentId: string;
  }): Promise<{ status: 'PENDING' | 'PROCESSED' | 'FAILED'; raw: Record<string, unknown> }> {
    const res = await requestJson<{ id?: string; status?: string }>({
      provider: 'razorpay',
      method: 'GET',
      url: `${API_BASE}/refunds/${encodeURIComponent(input.providerRefundId)}`,
      headers: headers(),
      idempotent: true,
      fetchImpl: this.fetchImpl,
    });
    if (res.status >= 400 || !res.body?.id) {
      throw new ProviderError('razorpay', 'validation', 'Razorpay refund lookup failed');
    }
    const status =
      res.body.status === 'processed' ? 'PROCESSED' : res.body.status === 'failed' ? 'FAILED' : 'PENDING';
    return { status, raw: { status: res.body.status ?? null } };
  }

  async checkHealth(): Promise<ProviderHealth> {
    if (!this.isConfigured()) return { status: 'DOWN', detail: 'Credentials not configured' };
    try {
      const res = await requestJson<{ items?: unknown[] }>({
        provider: 'razorpay',
        method: 'GET',
        url: `${API_BASE}/payments?count=1`,
        headers: headers(),
        timeoutMs: 8000,
        fetchImpl: this.fetchImpl,
      });
      return res.status < 400
        ? { status: 'OK', detail: 'Authenticated API call succeeded' }
        : { status: 'DEGRADED', detail: `Unexpected status ${res.status}` };
    } catch (err) {
      return {
        status: err instanceof ProviderError && err.kind === 'auth' ? 'DOWN' : 'DEGRADED',
        detail: err instanceof Error ? err.message : 'Health check failed',
      };
    }
  }
}

export function headerValue(
  headers: Record<string, string | string[] | undefined>,
  name: string,
): string | null {
  const lower = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === lower) {
      if (Array.isArray(value)) return value[0] ?? null;
      return value ?? null;
    }
  }
  return null;
}

function timingSafeHexEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function sha1Hex(input: Buffer): string {
  // Only used to build a deterministic fallback event id, never for security.
  return createHash('sha1').update(input).digest('hex');
}

/** Strips fields that must never reach logs or the UI. */
function sanitizeProviderError(body: unknown): Record<string, unknown> {
  if (!body || typeof body !== 'object') return {};
  const src = body as Record<string, unknown>;
  const error = (src.error ?? {}) as Record<string, unknown>;
  return {
    code: typeof error.code === 'string' ? error.code : undefined,
    description: typeof error.description === 'string' ? error.description.slice(0, 300) : undefined,
    field: typeof error.field === 'string' ? error.field : undefined,
  };
}
