import { getLogger } from '../observability/logger';
import { runMaintenanceCycle } from './jobs';

/**
 * In-process scheduler.
 *
 * Overlap is impossible: a tick is skipped while the previous cycle is still
 * running. Individual jobs catch their own errors, so one failing job cannot
 * stop the others.
 */
export function startScheduler(intervalSeconds: number): { stop: () => void; tickNow: () => Promise<void> } {
  const logger = getLogger().child({ component: 'scheduler' });
  let running = false;
  let stopped = false;
  let timer: NodeJS.Timeout | null = null;

  const tick = async (): Promise<void> => {
    if (running || stopped) return;
    running = true;
    try {
      await runMaintenanceCycle();
    } catch (err) {
      logger.error('maintenance cycle crashed', { error: err instanceof Error ? err.message : String(err) });
    } finally {
      running = false;
    }
  };

  const schedule = () => {
    timer = setTimeout(async () => {
      await tick();
      if (!stopped) schedule();
    }, intervalSeconds * 1000);
    timer.unref();
  };

  void tick();
  schedule();
  logger.info('scheduler started', { intervalSeconds });

  return {
    stop: () => {
      stopped = true;
      if (timer) clearTimeout(timer);
      logger.info('scheduler stopped');
    },
    tickNow: tick,
  };
}
