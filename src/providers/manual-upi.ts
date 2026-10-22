import { buildUpiUri, isValidVpa } from '../domain/upi';
import { ProviderError } from '../errors';
import {
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
 * Direct merchant UPI ID (static VPA) adapter.
 *
 * There is no authorised API to query a UPI VPA's incoming transactions. This
 * adapter therefore exposes NO status API, NO webhooks and NO refunds. Orders
 * paid this way can only be confirmed by a human operator against a bank
 * statement (reconciliation case) or by a supplementary Gmail candidate that a
 * human then approves. This limitation is deliberate and surfaced in the UI.
 */
export class ManualUpiProvider implements PaymentProvider {
  readonly name = 'manual_upi';
  readonly displayName = 'Direct UPI ID (merchant VPA)';
  readonly capabilities = {
    dynamicQr: true, // locally rendered intent QR with a fixed amount
    paymentRequest: false,
    statusApi: false,
    webhooks: false,
    refunds: false,
    reconciliation: false,
    simulated: false,
  } as const;

  isConfigured(): boolean {
    return true;
  }

  async createPayment(input: CreatePaymentInput): Promise<CreatePaymentResult> {
    const vpa = input.merchant.verifiedMerchantUpiId;
    if (!vpa || !isValidVpa(vpa)) {
      throw new ProviderError(
        'manual_upi',
        'validation',
        'Merchant has no operator-verified UPI ID; direct UPI collection is disabled',
      );
    }
    // The `tr` field carries our order reference so it appears in the payer's
    // UPI app history *where the app supports it*. It is not proof that the
    // bank will echo it back; the matcher never relies on it alone.
    const qrPayload = buildUpiUri({
      payeeVpa: vpa,
      payeeName: input.merchant.businessName,
      amountPaise: input.amountPaise,
      transactionRef: input.orderId,
      transactionNote: `Order ${input.orderId}`,
    });
    return {
      providerPaymentId: `upi-manual-${input.orderId}`,
      qrPayload,
      checkoutUrl: null,
      upiVpa: vpa,
      expiresAt: input.expiresAt,
      raw: { mode: 'direct_vpa' },
    };
  }

  async getPaymentStatus(_query: StatusQuery): Promise<StatusResult> {
    throw new ProviderError(
      'manual_upi',
      'unsupported',
      'Direct UPI transfers have no authorised status API; manual reconciliation is required',
    );
  }

  async verifyWebhook(): Promise<WebhookVerification> {
    throw new ProviderError('manual_upi', 'unsupported', 'Direct UPI has no webhooks');
  }

  parseWebhook(_payload: Record<string, unknown>): NormalizedWebhook {
    throw new ProviderError('manual_upi', 'unsupported', 'Direct UPI has no webhooks');
  }

  async refund(_input: RefundInput): Promise<RefundResult> {
    throw new ProviderError(
      'manual_upi',
      'unsupported',
      'Refunds for direct UPI transfers must be issued from the merchant bank account',
    );
  }

  async checkHealth(): Promise<ProviderHealth> {
    return { status: 'OK', detail: 'No external dependency; requires a verified merchant UPI ID' };
  }
}
