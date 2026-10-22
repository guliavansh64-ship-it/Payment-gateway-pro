import 'dotenv/config';
import { createApp } from './web/app';
import { getConfig } from './config';
import { getLogger } from './observability/logger';
import { closePool } from './db/pool';
import { startScheduler } from './workers/scheduler';

async function main(): Promise<void> {
  const config = getConfig();
  const logger = getLogger().child({ component: 'http' });
  const app = createApp();

  const server = app.listen(config.port, '0.0.0.0', () => {
    logger.info('server listening', { port: config.port, env: config.nodeEnv });
  });

  const scheduler = config.runBackgroundJobs
    ? startScheduler(config.reconciliationIntervalSeconds)
    : null;
  if (scheduler) logger.info('background jobs run in-process');

  const shutdown = async (signal: string): Promise<void> => {
    logger.info('shutdown requested', { signal });
    scheduler?.stop();
    server.close();
    await closePool().catch(() => undefined);
    setTimeout(() => process.exit(0), 3000).unref();
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));

  process.on('unhandledRejection', (reason) => {
    logger.error('unhandled rejection', { error: reason instanceof Error ? reason.message : String(reason) });
  });
  process.on('uncaughtException', (err) => {
    logger.error('uncaught exception', { error: err.message });
    // Do not keep serving requests with unknown state.
    process.exit(1);
  });
}

main().catch((err) => {
  console.error('Fatal startup error:', err instanceof Error ? err.message : err);
  process.exit(1);
});
