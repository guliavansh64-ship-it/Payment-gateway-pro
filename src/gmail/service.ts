import type { Merchant, Order } from '../domain/models';
import { getConfig } from '../config';
import { withTransaction } from '../db/pool';
import { AppError, ProviderError } from '../errors';
import { decryptSecret, encryptSecret, sha256 } from '../security/crypto';
import { getLogger } from '../observability/logger';
import * as ledger from '../repos/ledger';
import * as merchantRepo from '../repos/merchants';
import * as ops from '../repos/ops';
import * as orderRepo from '../repos/orders';
import { openReconciliationCase } from '../repos/ops';
import { matchTransaction } from '../services/matching';
import {
  recordCandidateTransaction,
  resolveMerchantForCandidate,
  toMatchCandidate,
  verifyOrderWithProvider,
  type NormalizedCandidate,
} from '../services/payments';
import { normalizeReference } from '../services/reference';
import { transitionOrder } from '../services/orders';
import { GmailApiError, GmailClient, getHeader, messageReceivedAt, type GmailMessage } from './client';
import { refreshAccessToken, revokeToken, isGoogleConfigured } from './oauth';
import {
  checkSender,
  extractBodyText,
  parseTransactionEmail,
  type ParsedTransactionEmail,
} from './parser';

/**
 * Gmail monitoring service.
 *
 * This module produces CANDIDATE transactions only. It can trigger an
 * authoritative provider status check for a matched order, and nothing more:
 * there is no code path from an email to PAID that does not pass through a
 * provider API or an audited human approval.
 */

export type GmailSyncSummary = {
  connectionId: string;
  messagesSeen: number;
  processed: number;
  ignored: number;
  duplicates: number;
  reviewRequired: number;
  errors: number;
  newCursor: string | null;
  stoppedReason: string | null;
};

const TOKEN_CACHE = new Map<string, { accessToken: string; expiresAt: number }>();

export async function decryptRefreshToken(connection: {
  id: string;
  userId: string;
  encryptedRefreshToken: string;
}): Promise<string> {
  return decryptSecret(connection.encryptedRefreshToken, `gmail:${connection.userId}`);
}

export function encryptRefreshToken(userId: string, token: string): string {
  return encryptSecret(token, `gmail:${userId}`);
}

async function getAccessToken(
  connection: {
    id: string;
    userId: string;
    encryptedRefreshToken: string;
  },
  fetchImpl?: typeof fetch,
): Promise<string> {
  const cached = TOKEN_CACHE.get(connection.id);
  if (cached && cached.expiresAt > Date.now() + 60_000) return cached.accessToken;
  const refreshToken = await decryptRefreshToken(connection);
  const tokens = await refreshAccessToken(refreshToken, fetchImpl);
  TOKEN_CACHE.set(connection.id, {
    accessToken: tokens.accessToken,
    expiresAt: Date.now() + Math.max(60, tokens.expiresInSeconds - 30) * 1000,
  });
  return tokens.accessToken;
}

export function clearTokenCache(connectionId: string): void {
  TOKEN_CACHE.delete(connectionId);
}

/** Builds the Gmail search query from the configured sender allow-list. */
export function buildGmailQuery(): string | null {
  const domains = getConfig().gmailAllowedSenderDomains;
  if (domains.length === 0) return null;
  const from = domains.map((d) => `from:${d}`).join(' OR ');
  // Narrow server-side so we never download the whole mailbox.
  return `(${from}) newer_than:7d`;
}

export async function syncGmailConnection(
  connection: {
    id: string;
    userId: string;
    merchantId: string | null;
    providerEmail: string;
    encryptedRefreshToken: string;
    historyCursor: string | null;
  },
  options: { maxMessages?: number; fetchImpl?: typeof fetch } = {},
): Promise<GmailSyncSummary> {
  const summary: GmailSyncSummary = {
    connectionId: connection.id,
    messagesSeen: 0,
    processed: 0,
    ignored: 0,
    duplicates: 0,
    reviewRequired: 0,
    errors: 0,
    newCursor: connection.historyCursor,
    stoppedReason: null,
  };

  const current = await ops.findGmailConnectionById(connection.id);
  if (!current || current.connectionStatus === 'REVOKED') {
    throw new AppError(
      'GMAIL_NOT_CONNECTED',
      'Gmail authorisation was revoked; reconnect the mailbox',
      409,
    );
  }

  const query = buildGmailQuery();
  if (!query) {
    throw new AppError(
      'PROVIDER_NOT_CONFIGURED',
      'No Gmail sender domains are configured; monitoring is disabled until an operator sets GMAIL_ALLOWED_SENDER_DOMAINS',
      409,
    );
  }

  let accessToken: string;
  try {
    accessToken = await getAccessToken(connection, options.fetchImpl);
  } catch (err) {
    const invalid = err instanceof ProviderError && err.details && (err.details as { error?: string }).error === 'invalid_grant';
    await ops.updateGmailSyncState(connection.id, {
      status: invalid ? 'REVOKED' : 'DEGRADED',
      lastError: invalid ? 'Google revoked the refresh token; reconnect Gmail' : 'Token refresh failed',
    });
    clearTokenCache(connection.id);
    throw new AppError(
      'GMAIL_NOT_CONNECTED',
      invalid ? 'Gmail authorisation was revoked; reconnect the mailbox' : 'Gmail token refresh failed',
      409,
    );
  }

  const client = new GmailClient(accessToken, options.fetchImpl);
  const messageIds = new Set<string>();

  try {
    if (connection.historyCursor) {
      try {
        const history = await client.listHistory(connection.historyCursor);
        for (const entry of history.history ?? []) {
          for (const added of entry.messagesAdded ?? []) messageIds.add(added.message.id);
        }
        if (history.historyId) summary.newCursor = history.historyId;
        summary.stoppedReason = 'HISTORY_SYNC';
      } catch (err) {
        if (err instanceof GmailApiError && err.statusCode === 404) {
          // Cursor expired (Gmail keeps history for ~a week). Recover with a
          // bounded message list rather than reprocessing the whole mailbox.
          summary.stoppedReason = 'HISTORY_EXPIRED_FALLBACK';
          connection = { ...connection, historyCursor: null };
        } else {
          throw err;
        }
      }
    }

    if (!connection.historyCursor || summary.stoppedReason === 'HISTORY_EXPIRED_FALLBACK') {
      const listed = await client.listMessages({ query, maxResults: options.maxMessages ?? 25 });
      for (const m of listed.messages ?? []) messageIds.add(m.id);
    }

    const profile = await client.getProfile();
    summary.newCursor = summary.newCursor ?? profile.historyId;

    const limit = options.maxMessages ?? 25;
    for (const id of [...messageIds].slice(0, limit)) {
      summary.messagesSeen += 1;
      try {
        const message = await client.getMessage(id);
        const result = await handleGmailMessage(connection, message);
        if (result === 'PROCESSED') summary.processed += 1;
        else if (result === 'DUPLICATE') summary.duplicates += 1;
        else if (result === 'REVIEW_REQUIRED') summary.reviewRequired += 1;
        else summary.ignored += 1;
      } catch (err) {
        summary.errors += 1;
        getLogger().warn('gmail message processing failed', {
          connectionId: connection.id,
          messageId: id,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    await ops.updateGmailSyncState(connection.id, {
      providedHistoryCursor: summary.newCursor,
      lastMessageAt: new Date(),
      lastError: summary.errors > 0 ? `${summary.errors} message(s) failed to process` : null,
      status: summary.errors > 0 ? 'DEGRADED' : 'CONNECTED',
    });
    return summary;
  } catch (err) {
    await ops.updateGmailSyncState(connection.id, {
      lastError: err instanceof Error ? err.message : 'Gmail sync failed',
      status: err instanceof GmailApiError && err.statusCode === 403 ? 'ERROR' : 'DEGRADED',
    });
    if (err instanceof GmailApiError) {
      throw new AppError('PROVIDER_UNAVAILABLE', `Gmail API error ${err.statusCode}`, 502);
    }
    throw err;
  }
}

export type GmailMessageOutcome = 'PROCESSED' | 'IGNORED' | 'DUPLICATE' | 'REVIEW_REQUIRED';

/**
 * Turns one Gmail message into a candidate transaction and (at most) triggers
 * authoritative verification of an already-matched order.
 */
export async function handleGmailMessage(
  connection: {
    id: string;
    userId: string;
    merchantId: string | null;
    providerEmail: string;
  },
  message: GmailMessage,
): Promise<GmailMessageOutcome> {
  const eventId = `gmail:${message.id}`;
  const fromHeader = getHeader(message, 'From');
  const subject = getHeader(message, 'Subject');
  const receivedAt = messageReceivedAt(message);
  const text = extractBodyText(message.payload ?? {});

  // Sender validation happens before anything is stored.
  const sender = checkSender(fromHeader, {
    allowedDomains: getConfig().gmailAllowedSenderDomains,
  });
  if (!sender.accepted) {
    await ledger.recordEvent({
      eventId,
      orderPk: null,
      paymentOrderRef: null,
      eventType: 'gmail.rejected_sender',
      source: 'GMAIL_NOTIFICATION',
      sourceReference: sender.domain,
      eventPayloadHash: sha256(`${message.id}|${fromHeader}|${receivedAt.toISOString()}`),
      payload: { reason: sender.reason, sender_domain: sender.domain },
    });
    await ledger.markEventProcessed(eventId, 'IGNORED');
    await ops.writeAudit({
      actorId: null,
      actorType: 'SYSTEM',
      action: 'GMAIL_SENDER_REJECTED',
      resourceType: 'gmail_connection',
      resourceId: connection.id,
      metadata: { reason: sender.reason, sender_domain: sender.domain },
    });
    return 'IGNORED';
  }

  const parsed = parseTransactionEmail({
    messageId: message.id,
    fromHeader,
    subject,
    receivedAt,
    text,
  });

  // The event row is the idempotency gate: a message is processed once.
  const recorded = await ledger.recordEvent({
    eventId,
    orderPk: null,
    paymentOrderRef: null,
    eventType: 'gmail.transaction_alert',
    source: 'GMAIL_NOTIFICATION',
    sourceReference: sender.domain,
    eventPayloadHash: sha256(`${message.id}|${sha256(text).slice(0, 16)}`),
    payload: {
      // Minimal audit record: no body, no subject, no addresses beyond domain.
      sender_domain: parsed.fromDomain,
      subject_hash: sha256(subject),
      amount_paise: parsed.amountPaise,
      direction: parsed.direction,
      status_guess: parsed.status,
      utr_present: Boolean(parsed.utr),
      confidence: parsed.confidence,
      warnings: parsed.warnings,
    },
  });
  if (!recorded.inserted) {
    await ledger.markEventProcessed(eventId, 'DUPLICATE');
    return 'DUPLICATE';
  }

  const outcome = await processParsedEmail(connection, parsed, eventId);
  await ledger.markEventProcessed(
    eventId,
    outcome === 'DUPLICATE' ? 'DUPLICATE' : outcome === 'IGNORED' ? 'IGNORED' : 'PROCESSED',
  );
  return outcome;
}

export async function processParsedEmail(
  connection: { id: string; merchantId: string | null; providerEmail: string },
  parsed: ParsedTransactionEmail,
  eventId: string,
): Promise<GmailMessageOutcome> {
  // Only incoming credits with a usable amount can ever be candidates.
  if (parsed.direction !== 'CREDIT' || parsed.amountPaise === null) {
    return 'IGNORED';
  }
  if (parsed.status === 'FAILED') {
    return 'IGNORED';
  }

  const merchant = await resolveMerchantForEmail(connection, parsed);
  if (!merchant) {
    await ops.writeAudit({
      actorId: null,
      actorType: 'SYSTEM',
      action: 'GMAIL_MERCHANT_UNRESOLVED',
      resourceType: 'gmail_connection',
      resourceId: connection.id,
      metadata: { payee_vpa_present: Boolean(parsed.payeeVpa) },
    });
    return 'IGNORED';
  }

  const reference = parsed.utr ? normalizeReference(parsed.utr) : null;
  const candidate: NormalizedCandidate = {
    // A neutral provider key: bank alerts are not a payment provider.
    providerName: 'upi_bank_alert',
    providerTransactionReference: reference,
    providerPaymentId: null,
    providerOrderReference: null,
    internalOrderReference: null,
    amountPaise: parsed.amountPaise,
    currency: 'INR',
    status: parsed.status === 'PENDING' ? 'PENDING' : 'SUCCESS',
    paidAt: parsed.receivedAt,
    payeeVpa: parsed.payeeVpa,
    failureReason: null,
    source: 'GMAIL_NOTIFICATION',
    eventId,
    raw: {
      sender_domain: parsed.fromDomain,
      confidence: parsed.confidence,
      warnings: parsed.warnings,
      provider_guess: parsed.providerGuess,
    },
  };

  // 1. Corroboration: is this UTR already known from an authoritative source?
  if (reference) {
    const authoritative = await ledger.findTransactionByReferenceAnyProvider(reference);
    if (authoritative && (authoritative.verificationStatus === 'VERIFIED' ||
        authoritative.verificationStatus === 'MANUALLY_VERIFIED')) {
      return withTransaction(async (client) => {
        const tx = await recordCandidateTransaction(client, {
          candidate,
          merchantId: merchant.id,
          orderPk: authoritative.orderPk,
          verificationStatus: 'VERIFIED',
          credited: false,
        });
        if (authoritative.orderPk) {
          await client.query(
            `UPDATE reconciliation_cases SET resolution_status = 'RESOLVED_PAID',
                    resolution_note = 'Corroborated by an already verified transaction'
              WHERE candidate_transaction_id = $1 AND resolution_status = 'OPEN'`,
            [tx.id],
          );
        }
        await ops.writeAudit(
          {
            actorId: null,
            actorType: 'SYSTEM',
            action: 'GMAIL_CORROBORATED',
            resourceType: 'payment_transaction',
            resourceId: tx.id,
            metadata: { authoritative_transaction_id: authoritative.id },
          },
          client,
        );
        return 'PROCESSED' as const;
      });
    }
  }

  // 2. Match against orders and store the candidate.
  const decision = await matchTransaction(toMatchCandidate(candidate), merchant.id);
  const stored = await withTransaction(async (client) => {
    const tx = await recordCandidateTransaction(client, {
      candidate,
      merchantId: merchant.id,
      orderPk: decision.order?.id ?? null,
      verificationStatus: 'UNVERIFIED',
      credited: false,
    });
    const reason =
      decision.outcome === 'AMBIGUOUS'
        ? 'AMBIGUOUS_MATCH'
        : decision.outcome === 'CONFLICT'
          ? 'WRONG_MERCHANT'
          : 'GMAIL_UNVERIFIED';
    await openReconciliationCase(
      {
        merchantId: merchant.id,
        candidateTransactionId: tx.id,
        orderPk: decision.order?.id ?? null,
        possibleOrderIds: decision.candidateOrders.map((o) => o.orderId),
        reason,
        detail: [
          'Gmail alert is not proof of payment',
          `outcome=${decision.outcome}`,
          `strategy=${decision.strategy}`,
          `confidence=${parsed.confidence}`,
          ...decision.evidence,
        ].join(' | '),
      },
      client,
    );
    return tx;
  });

  // 3. If an order is identified and its provider has a status API, ask the
  //    provider. That call — not the email — is what can confirm payment.
  if (decision.order && (decision.outcome === 'LINKED' || decision.outcome === 'INSUFFICIENT_EVIDENCE')) {
    const verification = await verifyOrderWithProvider(decision.order, { trigger: 'GMAIL_TRIGGER' });
    if (verification.kind === 'CONFIRMED') {
      await withTransaction(async (client) => {
        await client.query(
          `UPDATE reconciliation_cases SET resolution_status = 'RESOLVED_PAID',
                  resolution_note = 'Confirmed by provider API after Gmail alert'
            WHERE candidate_transaction_id = $1 AND resolution_status = 'OPEN'`,
          [stored.id],
        );
      });
      return 'PROCESSED';
    }
    if (verification.kind === 'PENDING') {
      return 'PROCESSED';
    }
    // Unsupported or unavailable: a human must decide.
    await withTransaction(async (client) => {
      const locked = await orderRepo.lockOrderForUpdate(client, decision.order!.id);
      if (locked && ['CREATED', 'PENDING', 'VERIFYING'].includes(locked.status)) {
        await transitionOrder(client, {
          orderPk: locked.id,
          toStatus: 'REVIEW_REQUIRED',
          verificationStatus: 'REVIEW_REQUIRED',
          reasonCode: 'GMAIL_NOTIFICATION_UNVERIFIED',
          actorType: 'SYSTEM',
          note: 'A bank alert suggests payment but it could not be verified automatically',
          metadataPatch: { gmail_event_id: eventId },
        });
      }
    });
    return 'REVIEW_REQUIRED';
  }

  if (!decision.order) {
    return 'REVIEW_REQUIRED';
  }
  return 'PROCESSED';
}

async function resolveMerchantForEmail(
  connection: { merchantId: string | null },
  parsed: ParsedTransactionEmail,
): Promise<Merchant | null> {
  if (connection.merchantId) {
    const merchant = await merchantRepo.findMerchantById(connection.merchantId);
    if (merchant) return merchant;
  }
  if (parsed.payeeVpa) {
    const byVpa = await merchantRepo.findMerchantByVerifiedUpi(parsed.payeeVpa);
    if (byVpa) return byVpa;
  }
  return resolveMerchantForCandidate({
    providerName: 'upi_bank_alert',
    providerTransactionReference: null,
    providerPaymentId: null,
    providerOrderReference: null,
    internalOrderReference: null,
    amountPaise: parsed.amountPaise,
    currency: 'INR',
    status: 'SUCCESS',
    paidAt: parsed.receivedAt,
    payeeVpa: parsed.payeeVpa,
    failureReason: null,
    source: 'GMAIL_NOTIFICATION',
    eventId: null,
    raw: {},
  });
}

/** Disconnect: revoke at Google and cryptographically erase the local token. */
export async function disconnectGmail(input: {
  userId: string;
  actorId: string;
  ipHash?: string | null;
}): Promise<void> {
  const connection = await ops.findGmailConnectionByUser(input.userId);
  if (!connection) throw new AppError('NOT_FOUND', 'No Gmail connection to disconnect', 404);

  let revokedAtGoogle = false;
  if (connection.encryptedRefreshToken !== 'revoked') {
    try {
      const refreshToken = await decryptRefreshToken(connection);
      revokedAtGoogle = await revokeToken(refreshToken);
    } catch {
      revokedAtGoogle = false;
    }
  }
  clearTokenCache(connection.id);
  await ops.markGmailRevoked(connection.id, revokedAtGoogle ? 'Disconnected and revoked at Google' : 'Disconnected locally; revoke at myaccount.google.com');
  await ops.writeAudit({
    actorId: input.actorId,
    actorType: 'USER',
    action: 'GMAIL_DISCONNECTED',
    resourceType: 'gmail_connection',
    resourceId: connection.id,
    metadata: { revoked_at_google: revokedAtGoogle },
    ipHash: input.ipHash ?? null,
  });
}

export function gmailConfigured(): boolean {
  return isGoogleConfigured() && getConfig().gmailAllowedSenderDomains.length > 0;
}

export type { Order };
