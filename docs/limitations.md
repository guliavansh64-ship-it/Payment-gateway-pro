# Known limitations

This file is deliberately blunt. A payment system that overstates its
capabilities is worse than one that admits them.

## Providers and integrations

1. **Razorpay and Cashfree adapters have not been exercised against live or
   sandbox accounts in this repository.** They are written against the public
   API documentation and covered by error-mapping tests, but go-live requires
   your own credentials and a full sandbox rehearsal.
2. **No direct integration with Google Pay, PhonePe, Paytm or BHIM exists.**
   These are consumer apps; they pay a UPI ID or a provider checkout. There is
   no public per-app "verify this payment" API. Any product claiming one is
   describing provider or bank infrastructure, not an app API.
3. **No bank core-banking, statement or IMAP integration.** Bank statement
   matching is manual. There are no bank API keys to obtain in this codebase.
4. **No settlement-file ingestion.** `capabilities.reconciliation` is `false`
   for every adapter; settlement/fee reconciliation is a manual process against
   the provider dashboard, or an adapter extension (see
   [providers.md](providers.md#settlement--reconciliation)).
5. **No chargeback/dispute automation.** A reversal or dispute becomes a review
   case; a human resolves it.
6. **`manual_upi` orders cannot be confirmed automatically.** A locally rendered
   UPI QR/ID has no status API. Such orders are confirmed by a provider webhook
   (if one exists for that payment) or by a human reviewing evidence.
7. **Provider API version drift.** Adapters pin request/response shapes as
   documented at the time of writing. Provider changes require adapter updates;
   the onboarding checklist exists for that reason.

## Gmail

8. **`gmail.readonly` is a Google restricted scope.** Until OAuth verification
   (which may include a CASA security assessment) is complete, only test users
   configured in the Google Cloud project can connect. See
   [gmail.md](gmail.md#google-oauth-verification-checklist).
9. **Gmail history expires after roughly a week.** The service falls back to a
   bounded message search and records `HISTORY_EXPIRED_FALLBACK`; messages
   outside that fallback window may be missed.
10. **Parsing is heuristic.** It handles common Indian bank/provider formats,
    but new formats can require parser updates. Unknown formats are stored as
    low-confidence candidates and routed to review, never auto-verified.
11. **Email is evidence, never proof.** A Gmail candidate can only reach `PAID`
    if an authorised provider API confirms it. With only `manual_upi`, a human
    decides.
12. **No Pub/Sub push mode.** Polling is the implemented path. `GOOGLE_PUBSUB_TOPIC`
    is reserved; push notifications are not wired.

## Functional gaps

13. **No application-level MFA.** Put the dashboard behind SSO/MFA or an
    identity-aware proxy for a pilot.
14. **No multi-currency.** INR only; the currency is stored and validated.
15. **No partial-payment top-up flow.** An underpayment goes to review; there is
    no automatic "pay the remainder" link.
16. **No customer accounts or payment links with reusable URLs.** Every order is
    a one-off request with a bearer token.
17. **No email/SMS notifications.** The product does not send messages; adding
    that requires a provider and consent handling.
18. **No webhook queue broker.** The database inbox is the queue. At very high
    webhook volume, move ingestion to a broker.
19. **No built-in load balancing or TLS termination.** Deploy behind a proxy.
20. **Refund status polling depends on the provider.** If an adapter cannot
    query refund status, a human reconciles it from the provider dashboard.
21. **Retention deletes event payloads, not financial ledger rows.** Legal
    retention must be decided per jurisdiction.

## Operational

22. **Rate limiting is per instance for IP buckets and database-backed for
    account buckets.** A multi-instance deployment shares account limits; IP
    limits are local to each process unless you front the app with a shared
    limiter.
23. **No built-in metrics endpoint.** Logs and `reconciliation_runs` are the
    observability surface; wire your own metrics/alerts.
24. **No formal pen-test or compliance certification** (PCI, SOC2, ISO). UPI
    collection does not involve card data, but provider/regulatory obligations
    still apply to your merchant account.
25. **Timezone/clock:** matching windows assume the database and app clocks are
    NTP-synced. A badly skewed host can widen or narrow the window.

## What this codebase will never do

- Ask a customer or merchant for a bank password, UPI PIN, OTP, Gmail password
  or app password.
- Render a screen that imitates a bank or UPI app to capture credentials.
- Mark an order `PAID` because an email, a browser, or an admin asserted it
  without evidence — manual approval is recorded as `MANUALLY_VERIFIED`, not as
  a provider confirmation.
- Invent provider references, API keys, bank APIs or settlement data.
- Claim an integration is live when it has not been tested with credentials.

If a requirement needs one of the above, the honest answer is a provider
onboarding project, not a code change.
