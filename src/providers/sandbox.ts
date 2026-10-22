import { Buffer } from 'node:buffer';
import { getConfig } from '../config';
import { buildUpiUri } from '../domain/upi';
import { ProviderError, WebhookSignatureError } from '../errors';
import { hmacSha256Hex, sha256 } from '../security/crypto';
import { query as dbQuery } from '../db/pool';
import { headerValue } from './razorpay';
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
 * SANDBOX / TEST DOUBLE — never real money.
 *
 * This adapter exists so the full pipeline (signature verification, event
 * inbox, matching, state machine, reconciliation) can be exercised end-to-end
 * without credentials. It is hard-disabled unless ALLOW_SANDBOX_PROVIDER=true
 * and NODE_ENV != production (enforced in config.ts and the registry).
 *
 * The "bank" is the local database: a simulated payment is delivered as a
 * signed webhook through the same endpoint real providers use. No code path
 * in this class can mark an order paid on its own.
 */
export class SandboxProvider implements PaymentProvider {
  readonly name = 'sandbox';
  readonly displayName = 'Sandbox (test double)';
  readonly capabilities = {
    dynamicQr: true,
    paymentRequest: true,
    statusApi: true,
    webhooks: true,
    refunds: true,
    reconciliation: false,
    simulated: true,
  } as const;

  isConfigured(): boolean {
    return getConfig().allowSandboxProvider && !getConfig().isProduction;
  }

  /** Domain-separated key: sandbox signatures cannot be confused with sessions. */
  private static signingKey(): string {
    return sha256(`sandbox-webhook|${getConfig().sessionSecret}`);
  }

  async createPayment(input: CreatePaymentInput): Promise<CreatePaymentResult> {
    this.assertEnabled();
    const paymentId = `sbx_${input.orderId.replace(/[^A-Za-z0-9]/g, '').toLowerCase()}`;
    // Simulated payments go to the merchant's own verified VPA when it has one,
    // so payee-matching logic is exercised realistically.
    const payeeVpa = input.merchant.verifiedMerchantUpiId ?? 'sandbox.merchant@upi';
    const qrPayload = buildUpiUri({
      payeeVpa,
      payeeName: `${input.merchant.businessName} (SANDBOX)`,
      amountPaise: input.amountPaise,
      transactionRef: input.orderId,
      transactionNote: 'SANDBOX - no real money',
    });
    return {
      providerPaymentId: paymentId,
      qrPayload,
      checkoutUrl: `${getConfig().appUrl}/sandbox/pay/${input.orderId}`,
      upiVpa: payeeVpa,
      expiresAt: input.expiresAt,
      raw: { simulated: true },
    };
  }

  /**
   * Reads the *simulated provider* state, not our ledger. That keeps the
   * status-polling path honest: it can only succeed if the provider side has a
   * record, exactly like a real adapter.
   */
  async getPaymentStatus(query: StatusQuery): Promise<StatusResult> {
    this.assertEnabled();
    const row = await dbQuery<{
      status: 'SUCCESS' | 'FAILED' | 'PENDING' | 'REVERSED';
      provider_transaction_reference: string | null;
      amount_paise: string;
      paid_at: Date | null;
      payee_vpa: string | null;
    }>(
      `SELECT status, provider_transaction_reference, amount_paise, paid_at, payee_vpa
         FROM sandbox_payments WHERE provider_payment_id = $1`,
      [query.providerPaymentId],
    );
    const payment = row.rows[0];
    if (!payment) {
      return {
        status: 'PENDING',
        providerPaymentId: query.providerPaymentId,
        providerTransactionReference: null,
        amountPaise: null,
        currency: 'INR',
        paidAt: null,
        payeeVpa: null,
        failureReason: null,
        raw: { simulated: true, found: false },
      };
    }
    return {
      status: mapStatus(payment.status),
      providerPaymentId: query.providerPaymentId,
      providerTransactionReference: payment.provider_transaction_reference,
      amountPaise: Number(payment.amount_paise),
      currency: 'INR',
      paidAt: payment.paid_at,
      payeeVpa: payment.payee_vpa,
      failureReason: null,
      raw: { simulated: true, found: true },
    };
  }

  /** Records the simulated payment on the "provider side". Test double only. */
  static async recordSimulatedPayment(input: {
    providerPaymentId: string;
    orderReference: string;
    status: 'SUCCESS' | 'FAILED' | 'PENDING' | 'REVERSED';
    amountPaise: number;
    providerTransactionReference: string;
    payeeVpa: string | null;
  }): Promise<void> {
    await dbQuery(
      `INSERT INTO sandbox_payments
         (provider_payment_id, order_reference, status, amount_paise,
          provider_transaction_reference, payee_vpa, paid_at)
       VALUES ($1,$2,$3,$4,$5,$6, CASE WHEN $3 = 'SUCCESS' THEN now() ELSE NULL END)
       ON CONFLICT (provider_payment_id) DO UPDATE
         SET status = EXCLUDED.status,
             amount_paise = EXCLUDED.amount_paise,
             provider_transaction_reference = EXCLUDED.provider_transaction_reference,
             paid_at = COALESCE(EXCLUDED.paid_at, sandbox_payments.paid_at),
             updated_at = now()`,
      [
        input.providerPaymentId,
        input.orderReference,
        input.status,
        input.amountPaise,
        input.providerTransactionReference,
        input.payeeVpa,
      ],
    );
  }

  async verifyWebhook(
    rawBody: Buffer,
    headersIn: Record<string, string | string[] | undefined>,
  ): Promise<WebhookVerification> {
    this.assertEnabled();
    const signature = headerValue(headersIn, 'x-sandbox-signature');
    if (!signature) throw new WebhookSignatureError('Missing X-Sandbox-Signature');
    const expected = hmacSha256Hex(SandboxProvider.signingKey(), rawBody);
    if (expected !== signature.toLowerCase()) throw new WebhookSignatureError();
    const parsed = JSON.parse(rawBody.toString('utf8')) as Record<string, unknown>;
    return {
      eventId: String(parsed.event_id ?? ''),
      eventType: String(parsed.event_type ?? 'unknown'),
      occurredAt: parsed.paid_at ? new Date(String(parsed.paid_at)) : new Date(),
      signatureScheme: 'hmac-sha256-hex(raw-body)',
      timestampFresh: true,
    };
  }

  parseWebhook(payload: Record<string, unknown>): NormalizedWebhook {
    return {
      eventId: String(payload.event_id ?? ''),
      eventType: String(payload.event_type ?? 'unknown'),
      providerPaymentId: payload.provider_payment_id ? String(payload.provider_payment_id) : null,
      providerOrderReference: payload.order_reference ? String(payload.order_reference) : null,
      providerTransactionReference: payload.provider_transaction_reference
        ? String(payload.provider_transaction_reference)
        : null,
      amountPaise: typeof payload.amount_paise === 'number' ? payload.amount_paise : null,
      currency: payload.currency ? String(payload.currency) : 'INR',
      status: mapStatus(String(payload.status ?? '')),
      paidAt: payload.paid_at ? new Date(String(payload.paid_at)) : null,
      payeeVpa: payload.payee_vpa ? String(payload.payee_vpa) : null,
      failureReason: payload.failure_reason ? String(payload.failure_reason) : null,
      internalOrderReference: payload.order_reference ? String(payload.order_reference) : null,
      raw: { simulated: true },
    };
  }

  async refund(input: RefundInput): Promise<RefundResult> {
    this.assertEnabled();
    return {
      providerRefundId: `sbxrf_${sha256(input.internalRefundId).slice(0, 16)}`,
      status: 'PROCESSED',
      raw: { simulated: true },
    };
  }

  async getRefundStatus(): Promise<{ status: 'PENDING' | 'PROCESSED' | 'FAILED'; raw: Record<string, unknown> }> {
    this.assertEnabled();
    return { status: 'PROCESSED', raw: { simulated: true } };
  }

  async checkHealth(): Promise<ProviderHealth> {
    return this.isConfigured()
      ? { status: 'OK', detail: 'Test double active — no real payments' }
      : { status: 'DOWN', detail: 'Sandbox provider disabled' };
  }

  /** Builds the signed payload the sandbox webhook endpoint expects. */
  static buildSignedEvent(payload: Record<string, unknown>): { body: string; signature: string } {
    const body = JSON.stringify(payload);
    const signature = hmacSha256Hex(SandboxProvider.signingKey(), Buffer.from(body));
    return { body, signature };
  }

  private assertEnabled(): void {
    if (!this.isConfigured()) {
      throw new ProviderError(
        'sandbox',
        'not_configured',
        'Sandbox provider is disabled (ALLOW_SANDBOX_PROVIDER=false or production mode)',
      );
    }
  }
}
