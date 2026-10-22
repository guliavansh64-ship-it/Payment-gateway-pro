import 'dotenv/config';
import { getConfig } from './config';
import { getLogger } from './observability/logger';
import { closePool } from './db/pool';
import { runMaintenanceCycle } from './workers/jobs';

/**
 * Standalone reconciliation worker.
 *
 * Runs one cycle per RECONCILIATION_INTERVAL_SECONDS. Multiple replicas are
 * safe: all financial mutations are row-locked and idempotent, so duplicate
 * work is wasted effort rather than double credit.
 */
async function main(): Promise<void> {
  const config = getConfig();
  const logger = getLogger().child({ component: 'worker' });
  let stopped = false;
  let timer: NodeJS.Timeout | null = null;

  const loop = async (): Promise<void> => {
    if (stopped) return;
    try {
      const reports = await runMaintenanceCycle();
      logger.info('cycle complete', {
        jobs: reports.map((r) => `${r.job}:${r.checked}/${r.changed}/${r.errors}`).join(','),
      });
    } catch (err) {
      logger.error('cycle failed', { error: err instanceof Error ? err.message : String(err) });
    }
    if (!stopped) {
      timer = setTimeout(loop, config.reconciliationIntervalSeconds * 1000);
      timer.unref();
    }
  };

  logger.info('worker started', { intervalSeconds: config.reconciliationIntervalSeconds });
  await loop();

  const shutdown = async (signal: string): Promise<void> => {
    logger.info('worker shutting down', { signal });
    stopped = true;
    if (timer) clearTimeout(timer);
    await closePool().catch(() => undefined);
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

main().catch((err) => {
  console.error('Worker failed to start:', err instanceof Error ? err.message : err);
  process.exit(1);
});
