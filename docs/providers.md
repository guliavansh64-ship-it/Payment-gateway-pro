# Payment providers

## Adapter interface

Every provider implements `PaymentProvider` (`src/providers/types.ts`):

```ts
interface PaymentProvider {
  readonly name: string;
  readonly displayName: string;
  readonly capabilities: ProviderCapabilities;

  isConfigured(): boolean;
  createPayment(input: CreatePaymentInput): Promise<CreatePaymentResult>;
  getPaymentStatus(query: StatusQuery): Promise<StatusResult>;
  verifyWebhook(rawBody, headers): Promise<WebhookVerification>;
  parseWebhook(payload): NormalizedWebhook;
  refund(input: RefundInput): Promise<RefundResult>;
  getRefundStatus?(input): Promise<RefundResult>;   // optional
  checkHealth(): Promise<ProviderHealth>;
}
```

Rules for adapters:

- Never fabricate a success. Unsupported operations throw
  `ProviderError(provider, 'unsupported', …)`.
- Signatures are verified on the raw bytes, before JSON parsing.
- Status values are mapped to the canonical set
  (`SUCCESS | FAILED | PENDING | REVERSED | REFUNDED | UNKNOWN`).
- Errors are typed: `auth`, `rate_limited`, `unavailable`, `validation`,
  `malformed_response`, `unsupported`. Only `unavailable`/`rate_limited` are
  retryable by default.
- A capability flag must be honest: if the provider cannot issue a dynamic QR,
  `dynamicQr: false`, and the UI must not show a QR for it.

## Capability matrix (as implemented)

| Provider | Dynamic QR | Payment request | Status API | Webhooks | Refunds | Settlement | Simulated |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `razorpay` | yes (QR create) | yes (Orders/QR) | yes | yes (HMAC `X-Razorpay-Signature`) | yes | no | no |
| `cashfree` | no (QR inside checkout) | yes (Orders + payment session) | yes | yes (signature header) | yes | no | no |
| `manual_upi` | yes (locally built intent URI) | no | **no** | no | no | no | no |
| `sandbox` | yes | yes | yes | yes (HMAC) | yes | no | **yes** |

`manual_upi` is a real collection method, not a provider: the payer scans a
fixed-amount UPI intent URI that pays the merchant's verified VPA. There is no
API to ask "did this VPA receive money?" — so its confidence comes from manual
review or an independent provider/webhook. The UI says so.

> **Reality check:** Google Pay, PhonePe, Paytm and BHIM are consumer UPI apps,
> not merchant APIs. A UPI QR/ID can be paid by any of them; the platform sees
> the resulting bank/provider confirmation, not the app. This repository does
> not claim a special integration with those apps.

## Credentials and where to get them

Never invent keys. All values are placeholders in `.env.example`.

### Razorpay

1. Create an account at <https://dashboard.razorpay.com> and complete KYC.
2. Test mode: **Account & Settings → API Keys → Generate Key**. Copy the key id
   and secret into `RAZORPAY_KEY_ID` / `RAZORPAY_KEY_SECRET`.
3. **Account & Settings → Webhooks → Add webhook**:
   - URL: `https://your-host/webhooks/razorpay`
   - secret: generate a random string, store in `RAZORPAY_WEBHOOK_SECRET`
   - events: at minimum `payment.captured`, `payment.failed`, `payment.pending`,
     `refund.processed` (subscribe to what your plan exposes).
4. Set `RAZORPAY_MODE=test` until the go-live checklist is complete.
5. Live mode uses a different key pair and a different webhook endpoint
   configuration; rotate both.

### Cashfree

1. Create an account at <https://merchant.cashfree.com>.
2. **Developers → API Keys** for the sandbox/production client id + secret.
3. **Developers → Webhooks**: URL `https://your-host/webhooks/cashfree`,
   configure the same secret you put in `CASHFREE_WEBHOOK_SECRET`.
4. `CASHFREE_MODE=sandbox` until go-live.

### Verification after configuration

- `GET /webhooks/<provider>` returns `{configured: true}` (no secrets).
- `POST /api/orders` with `"provider": "<name>"` returns a real provider
  reference and QR/checkout URL.
- Admin → Providers shows health `OK`, not `UNKNOWN`.
- Create a low-value live test order only after the pilot checklist.

## Signature and replay handling

- Razorpay: HMAC-SHA256 of the raw body with the webhook secret, compared in
  constant time; the adapter also checks the event timestamp for replay.
- Cashfree: signature over timestamp + raw body per Cashfree's documented
  scheme.
- Every event id is unique in `payment_events`; a replay is acknowledged with
  200 `DUPLICATE` and cannot credit twice.
- The raw body limit is 256 kB; oversized bodies are rejected before parsing.

## Refunds

- Refund calls carry our internal refund id as the provider idempotency key.
- `PROCESSED` is the only status that moves money and changes the order.
- `PENDING` refunds are retried by the worker / reconciled by an admin.
- Where an adapter reports `unsupported`, the dashboard refuses the action and
  tells the operator to use the provider dashboard. The platform never fakes a
  refund.

## Settlement / reconciliation

No adapter currently downloads settlement files. `capabilities.reconciliation`
is `false` for all four adapters, and the UI does not pretend otherwise.
Reconciliation today means:

- provider status polling for every open order,
- refund status polling,
- a daily invariant report (paid orders without a credited transaction, credited
  transactions without a paid order, stuck review cases).

To add settlement ingestion:

1. Extend the interface with an optional `listSettlements(range)` returning
   normalised rows (provider payment id, UTR, gross, fee, net, settled-at).
2. Implement it in the adapter using the provider's documented report API.
3. Add a job that stores raw rows, matches on provider payment id/UTR, and opens
   a case on any mismatch. Never derive fees silently.

## Onboarding checklist

Use this for every new provider (and re-run it after provider API changes).

- [ ] Merchant account, KYC and payout account are live with the provider.
- [ ] Sandbox credentials obtained; test-mode flag set.
- [ ] Adapter implemented with honest `capabilities`.
- [ ] `createPayment` returns a payable instruction for the exact amount, or
      throws — never a fake reference.
- [ ] `getPaymentStatus` verified against the provider's sandbox for success,
      failure and pending cases.
- [ ] Webhook signature verified with a tampered payload (must fail).
- [ ] Replay of the same event id is a no-op.
- [ ] Refund create + status verified in sandbox; over-refund refused locally.
- [ ] Currency and amount units checked (paise vs rupees).
- [ ] Timeouts/retries behave: timeout → retryable, auth error → not retryable.
- [ ] Rate-limit responses (`429`) mapped to `rate_limited`.
- [ ] Provider health check implemented.
- [ ] Webhook URL registered and tested from the provider's dashboard.
- [ ] Keys stored in a secret manager; rotation procedure written down.
- [ ] Settlement/reconciliation method documented (even if manual).
- [ ] Support escalation contact recorded.

## Adding an adapter

1. Create `src/providers/<name>.ts` implementing the interface.
2. Register it in `src/providers/registry.ts` (`builtins`).
3. Add its env vars to `src/config.ts` and `.env.example` (placeholders only).
4. Add the provider to the onboarding checklist above and to
   `docs/limitations.md` if anything is unsupported.
5. Add contract tests using a recorded/fake HTTP layer — never live keys in CI.
6. Do not enable it for merchants until the checklist is complete.
