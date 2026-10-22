import { getConfig } from '../config';
import { withTransaction } from '../db/pool';
import { AppError } from '../errors';
import type { Order } from '../domain/models';
import { getLogger } from '../observability/logger';
import * as ledger from '../repos/ledger';
import * as orderRepo from '../repos/orders';
import * as ops from '../repos/ops';
import { getProvider, providerPublicInfo, tryGetProvider } from '../providers/registry';
import { transitionOrder } from '../services/orders';
import { processEvent, verifyOrderWithProvider } from '../services/payments';
import { reconcileRefund } from '../services/refunds';
import { listActiveGmailConnections } from '../repos/ops';
import { syncGmailConnection } from '../gmail/service';

/**
 * Background jobs.
 *
 * Every job is idempotent and safe to run concurrently with itself: financial
 * mutations are wrapped in row-locked transactions, and run summaries are
 * stored in reconciliation_runs for operators.
 */

export type JobReport = {
  job: string;
  checked: number;
  changed: number;
  errors: number;
  detail?: string;
};

const log = () => getLogger().child({ component: 'worker' });

export async function sweepExpiredOrders(limit = 100): Promise<JobReport> {
  const runId = await ops.startRun('EXPIRY_SWEEP');
  const report: JobReport = { job: 'EXPIRY_SWEEP', checked: 0, changed: 0, errors: 0 };
  try {
    const candidates = await orderRepo.findExpiredCandidates(limit);
    for (const candidate of candidates) {
      report.checked += 1;
      try {
        const changed = await withTransaction(async (client) => {
          const order = await orderRepo.lockOrderForUpdate(client, candidate.id);
          if (!order) return false;
          if (!['CREATED', 'PENDING', 'VERIFYING'].includes(order.status)) return false;
          if (order.expiresAt.getTime() > Date.now()) return false;
          await transitionOrder(client, {
            orderPk: order.id,
            toStatus: 'EXPIRED',
            verificationStatus: order.verificationStatus,
            reasonCode: 'PAYMENT_WINDOW_ELAPSED',
            actorType: 'SYSTEM',
            note: 'Payment window elapsed without an authoritative confirmation. Reconciliation continues for late payments.',
          });
          return true;
        });
        if (changed) report.changed += 1;
      } catch (err) {
        report.errors += 1;
        log().warn('expiry sweep failed for order', {
          orderId: candidate.orderId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
    await ops.finishRun(runId, report.errors > 0 ? 'PARTIAL' : 'OK', report.checked, report.changed);
    return report;
  } catch (err) {
    await ops.finishRun(runId, 'FAILED', report.checked, report.changed, err instanceof Error ? err.message : '');
    throw err;
  }
}

export async function reconcileProviderOrders(limit = 25): Promise<JobReport> {
  const runId = await ops.startRun('PROVIDER_RECON');
  const report: JobReport = { job: 'PROVIDER_RECON', checked: 0, changed: 0, errors: 0 };
  try {
    const orders = await orderRepo.findOrdersForReconciliation(limit);
    for (const order of orders) {
      report.checked += 1;
      try {
        const before = order.status;
        const result = await verifyOrderWithProvider(order, { trigger: 'RECONCILIATION' });
        if (result.kind === 'CONFIRMED' || result.kind === 'FAILED') {
          if (result.order.status !== before) report.changed += 1;
        } else if (result.kind === 'UNAVAILABLE') {
          report.errors += 1;
        }
      } catch (err) {
        report.errors += 1;
        log().warn('provider reconciliation failed', {
          orderId: order.orderId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
    await ops.finishRun(runId, report.errors > 0 ? 'PARTIAL' : 'OK', report.checked, report.changed);
    return report;
  } catch (err) {
    await ops.finishRun(runId, 'FAILED', report.checked, report.changed, err instanceof Error ? err.message : '');
    throw err;
  }
}

export async function retryFailedEvents(limit = 25): Promise<JobReport> {
  const runId = await ops.startRun('EVENT_RETRY');
  const report: JobReport = { job: 'EVENT_RETRY', checked: 0, changed: 0, errors: 0 };
  try {
    const events = await ledger.findRetryableEvents(limit);
    for (const event of events) {
      report.checked += 1;
      const providerName = typeof event.payload['_provider'] === 'string' ? event.payload['_provider'] : null;
      if (!providerName) {
        await ledger.markEventProcessed(event.eventId, 'IGNORED');
        continue;
      }
      try {
        const provider = getProvider(providerName);
        const normalized = provider.parseWebhook(event.payload);
        normalized.eventId = event.eventId;
        const result = await processEvent(event.eventId, normalized, providerName, null);
        if (result.outcome === 'PROCESSED' || result.outcome === 'REVIEW_REQUIRED') report.changed += 1;
        if (result.outcome === 'FAILED_RETRYABLE') report.errors += 1;
      } catch (err) {
        report.errors += 1;
        log().warn('event retry failed', {
          eventId: event.eventId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
    await ops.finishRun(runId, report.errors > 0 ? 'PARTIAL' : 'OK', report.checked, report.changed);
    return report;
  } catch (err) {
    await ops.finishRun(runId, 'FAILED', report.checked, report.changed, err instanceof Error ? err.message : '');
    throw err;
  }
}

export async function reconcilePendingRefunds(limit = 20): Promise<JobReport> {
  const report: JobReport = { job: 'REFUND_RECON', checked: 0, changed: 0, errors: 0 };
  const refunds = await ops.listRefundsNeedingReconciliation(limit);
  for (const refund of refunds) {
    report.checked += 1;
    try {
      const result = await reconcileRefund({ refundId: refund.id, adminId: null });
      if (result.refund.status !== refund.status) report.changed += 1;
    } catch (err) {
      if (err instanceof AppError && err.code === 'PROVIDER_NOT_CONFIGURED') {
        // Provider cannot report refund status; leave for manual reconciliation.
        continue;
      }
      report.errors += 1;
      log().warn('refund reconciliation failed', {
        refundId: refund.id,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return report;
}

export async function pollGmailConnections(limit = 10): Promise<JobReport> {
  const runId = await ops.startRun('GMAIL_POLL');
  const report: JobReport = { job: 'GMAIL_POLL', checked: 0, changed: 0, errors: 0 };
  try {
    const connections = await listActiveGmailConnections();
    for (const connection of connections.slice(0, limit)) {
      report.checked += 1;
      try {
        const summary = await syncGmailConnection(connection);
        report.changed += summary.processed;
      } catch (err) {
        report.errors += 1;
        log().warn('gmail sync failed', {
          connectionId: connection.id,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
    await ops.finishRun(runId, report.errors > 0 ? 'PARTIAL' : 'OK', report.checked, report.changed);
    return report;
  } catch (err) {
    await ops.finishRun(runId, 'FAILED', report.checked, report.changed, err instanceof Error ? err.message : '');
    throw err;
  }
}

export async function checkProviderHealth(): Promise<JobReport> {
  const report: JobReport = { job: 'HEALTH_CHECK', checked: 0, changed: 0, errors: 0 };
  for (const info of providerPublicInfo()) {
    const provider = tryGetProvider(info.name);
    if (!provider || !provider.isConfigured()) continue;
    report.checked += 1;
    try {
      const health = await provider.checkHealth();
      await ops.recordProviderHealth(provider.name, health.status, health.detail);
      if (health.status === 'DOWN') report.errors += 1;
    } catch (err) {
      report.errors += 1;
      log().warn('provider health check failed', {
        provider: info.name,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return report;
}

export async function purgeExpiredData(): Promise<JobReport> {
  const config = getConfig();
  const report: JobReport = { job: 'RETENTION', checked: 0, changed: 0, errors: 0 };
  const purged = await ops.purgeRetention({
    paymentEventsDays: config.retention.paymentEventsDays,
    auditLogsDays: config.retention.auditLogsDays,
  });
  report.changed = purged.eventsDeleted + purged.auditDeleted + purged.sessionsDeleted;
  report.detail = JSON.stringify(purged);
  return report;
}

/** Runs one maintenance cycle. Failures in one job never stop the others. */
export async function runMaintenanceCycle(): Promise<JobReport[]> {
  const jobs: Array<[string, () => Promise<JobReport>]> = [
    ['expiry', () => sweepExpiredOrders()],
    ['provider-recon', () => reconcileProviderOrders()],
    ['event-retry', () => retryFailedEvents()],
    ['refund-recon', () => reconcilePendingRefunds()],
    ['gmail-poll', () => pollGmailConnections()],
    ['health', () => checkProviderHealth()],
  ];
  const reports: JobReport[] = [];
  for (const [name, job] of jobs) {
    try {
      const report = await job();
      if (report.checked > 0 || report.changed > 0 || report.errors > 0) {
        log().info('job finished', report as unknown as Record<string, unknown>);
      }
      reports.push(report);
    } catch (err) {
      log().error('job crashed', { job: name, error: err instanceof Error ? err.message : String(err) });
      reports.push({ job: name, checked: 0, changed: 0, errors: 1 });
    }
  }
  return reports;
}

/** Hourly housekeeping: retention and expired sessions. */
export async function runDailyHousekeeping(): Promise<JobReport[]> {
  return [await purgeExpiredData()];
}
