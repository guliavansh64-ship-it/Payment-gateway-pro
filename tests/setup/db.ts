import { afterAll, beforeEach } from 'vitest';
import { resetTestEnv } from './env';
import { closePool, query } from '../../src/db/pool';
import { resetProviders } from '../../src/providers/registry';
import { resetConfigCache } from '../../src/config';

const TABLES = [
  'sandbox_payments',
  'refunds',
  'reconciliation_cases',
  'payment_events',
  'payment_transactions',
  'order_status_history',
  'payment_orders',
  'reconciliation_runs',
  'gmail_connections',
  'audit_logs',
  'user_sessions',
  'rate_limits',
  'merchants',
  'provider_configs',
  'users',
];

/**
 * Every test starts from an empty database. Files run serially in one fork so
 * truncation cannot race with another file's fixtures.
 */
export async function resetDatabase(): Promise<void> {
  await query(`TRUNCATE TABLE ${TABLES.join(', ')} RESTART IDENTITY CASCADE`);
}

beforeEach(async () => {
  resetTestEnv();
  resetProviders();
  resetConfigCache();
  await resetDatabase();
});

afterAll(async () => {
  await closePool();
});
