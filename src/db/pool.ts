import { Pool, type PoolClient, type QueryResult, type QueryResultRow } from 'pg';
import { getConfig } from '../config';
import { getLogger } from '../observability/logger';

let pool: Pool | null = null;

export function getPool(): Pool {
  if (!pool) {
    const config = getConfig();
    pool = new Pool({
      connectionString: config.databaseUrl,
      max: config.dbPoolMax,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 10_000,
      ssl:
        config.pgSslMode === 'disable'
          ? undefined
          : { rejectUnauthorized: config.pgSslMode === 'verify-full' },
      application_name: 'upi-verify',
    });
    pool.on('error', (err) => {
      getLogger().error('idle database client error', { error: err.message });
    });
  }
  return pool;
}

export async function query<T extends QueryResultRow = QueryResultRow>(
  text: string,
  params: readonly unknown[] = [],
): Promise<QueryResult<T>> {
  const started = Date.now();
  try {
    const res = await getPool().query<T>(text, params as unknown[]);
    const duration = Date.now() - started;
    if (duration > 250) {
      getLogger().warn('slow query', { durationMs: duration, sql: text.slice(0, 120) });
    }
    return res;
  } catch (err) {
    getLogger().error('query failed', {
      sql: text.slice(0, 200),
      error: err instanceof Error ? err.message : String(err),
    });
    throw err;
  }
}

export async function one<T extends QueryResultRow = QueryResultRow>(
  text: string,
  params: readonly unknown[] = [],
): Promise<T | null> {
  const res = await query<T>(text, params);
  return res.rows[0] ?? null;
}

export async function withTransaction<T>(
  fn: (client: PoolClient) => Promise<T>,
  options: { isolation?: 'read committed' | 'repeatable read' | 'serializable' } = {},
): Promise<T> {
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    if (options.isolation) {
      await client.query(`SET TRANSACTION ISOLATION LEVEL ${options.isolation.toUpperCase()}`);
    }
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch {
      /* connection may already be gone */
    }
    throw err;
  } finally {
    client.release();
  }
}

export async function closePool(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = null;
  }
}
