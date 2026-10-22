# Gmail notification intake (supplementary evidence only)

> **Non-negotiable rule:** Gmail is an *early warning system*, not a payment
> authority. A parsed email creates a candidate transaction. It may trigger an
> authorised provider status check. It can never set `PAID` by itself, and an
> email claiming "payment received" is not proof of anything until a provider
> or acquiring bank confirms it.

## What is requested from the user

OAuth 2.0 authorisation for:

- `https://www.googleapis.com/auth/gmail.readonly` (read-only; restricted scope)
- `openid` + `email` (to display which mailbox is connected)

No passwords, no app passwords, no "less secure apps", no IMAP. The platform
never asks the user to forward mail to a third party.

## OAuth flow

1. Signed-in merchant visits `/dashboard/gmail` → **Connect Gmail**.
2. `GET /oauth/google/start` creates a signed, expiring `state` value bound to
   the user and redirects to Google with `access_type=offline`,
   `prompt=consent`, `include_granted_scopes=true`.
3. Google redirects to `/oauth/google/callback` (must exactly match
   `GOOGLE_OAUTH_REDIRECT_URI`).
4. The callback verifies the state, exchanges the code at
   `https://oauth2.googleapis.com/token`, and reads the mailbox address from
   `https://openidconnect.googleapis.com/v1/userinfo`.
5. The refresh token is encrypted with AES-256-GCM using
   `TOKEN_ENCRYPTION_KEYS` and associated data bound to the owning user id, then
   stored in `gmail_connections` with `token_key_version`. The plaintext token
   never reaches the database, logs or the browser.
6. Granted scopes are recorded. If `gmail.readonly` was not granted, the
   connection is rejected with a clear message.
7. Disconnect (`POST /dashboard/gmail/disconnect`) revokes the token at
   `https://oauth2.googleapis.com/revoke` and marks the row revoked; the
   encrypted token is cleared.

State, code and tokens are never logged. `state` is single-use and
short-lived (signed-state helper in `src/security/signed-state.ts`).

## Polling and history recovery

- The worker polls each connection on `GMAIL_POLL_INTERVAL_SECONDS`.
- First sync reads the profile's `historyId` and stores it.
- Subsequent syncs call `users.history.list(startHistoryId=…)` and process only
  messages added since then.
- If Gmail returns 404 (history expired — Gmail keeps it for about a week), the
  service falls back to a bounded `messages.list` search over allow-listed
  senders, records `HISTORY_EXPIRED_FALLBACK`, then resumes from the new
  `historyId`.
- Message processing is idempotent: `gmail:<messageId>` is unique in
  `payment_events`; a repeated poll cannot double-count.
- Sync failures set `status=DEGRADED` with `last_error`; 401/invalid_grant
  revokes the connection and requires the merchant to reconnect.

## Sender allow-list and spoofing defence

Configured with `GMAIL_ALLOWED_SENDER_DOMAINS` (comma-separated). The list is
**empty by default**, which disables Gmail monitoring entirely — the platform
never guesses which senders to trust.

`checkSender()` in `src/gmail/parser.ts`:

- extracts the actual address from the `From` header (not the display name);
- accepts only an exact domain match or a subdomain of an allow-listed domain;
- rejects lookalikes (`hdfcbank.net.evil.test`, `hdfcbank-net.test`, …);
- rejects mismatched display names (`"HDFC Bank <attacker@example.com>"`);
- records only the sender *domain* and a subject hash — not the body.

Emails are also classified conservatively: forwarded alerts are down-weighted
and never auto-verify; debits, failures and "request money" mails are ignored.

## Parsing

`parseTransactionEmail()` handles realistic bank/provider alerts:

- HTML-only mail is converted to text (`htmlToText`), entities decoded, tags
  stripped, whitespace collapsed.
- multipart/alternative prefers `text/plain`, falls back to `text/html`.
- amounts: `Rs. 1,234.50`, `INR 1234.5`, `₹1,234`, `Rs 1234/-`.
- references: `UTR`, `RRN`, `UPI transaction ID`, `Ref No`, 12-digit UTRs.
- VPAs are extracted, but bank support addresses (e.g. `support@…`) are ignored.
- direction is `CREDIT` only for explicit credit phrasing ("credited",
  "received", "money received"); everything else is `UNKNOWN`/`DEBIT`.
- status guesses are conservative (`SUCCESS` only with clear credit wording).
- malformed input never throws; it returns `confidence: 0` and warnings.

## What happens to a parsed candidate

1. Stored as `payment_transactions` with `source='GMAIL_NOTIFICATION'`,
   `verification_status='UNVERIFIED'`.
2. Matching runs with the same ladder as provider events.
3. If it links to an order **and** the order's provider has a status API, the
   service calls the provider. Provider confirmation sets `PAID` with
   `verification_source='PROVIDER_API'`. The email remains corroboration.
4. If the provider cannot confirm, or there are two plausible orders, or the
   amount differs, a `reconciliation_cases` row is opened with
   `REVIEW_REQUIRED`. A human decides.
5. If no order exists at all, the candidate is stored unassigned so the money
   is not lost from the record.

## Google OAuth verification checklist

Publishing an app that uses `gmail.readonly` for external users requires Google
verification (restricted scope). Until it is granted, only test users added in
the OAuth consent screen can connect.

- [ ] Google Cloud project created; Gmail API enabled.
- [ ] OAuth consent screen configured: app name, support email, logo, privacy
      policy URL, terms URL, authorised domains.
- [ ] Scopes declared: `gmail.readonly`, `openid`, `email` — and nothing more.
- [ ] `GOOGLE_OAUTH_REDIRECT_URI` registered exactly (https in production).
- [ ] Demo video recorded showing: connect, consent screen, dashboard, what is
      read, disconnect/revoke.
- [ ] Privacy policy states: what is read (transaction alerts), why, where it is
      stored, retention, how to disconnect, contact.
- [ ] Limited Use disclosure: Gmail data is used only to detect payment
      notifications, never for advertising, never sold, never used to train
      models.
- [ ] Data deletion path documented and working (disconnect + retention job).
- [ ] Security assessment (CASA) completed if required for the scope/use case.
- [ ] Verification request submitted; test users configured for the interim.
- [ ] Token revocation tested from the Google account's "Third-party access"
      page and from the app's disconnect button.
- [ ] Incident contact and breach notification process written down.

## Operational checks

- `gmail_connections.status` should be `CONNECTED`; `DEGRADED` means messages
  failed, `REVOKED` means reconnect is required.
- The worker never crashes on a single bad mailbox; errors are counted per run.
- Turning off `GMAIL_ALLOWED_SENDER_DOMAINS` (or emptying it) stops intake
  immediately; provider verification continues unaffected.
