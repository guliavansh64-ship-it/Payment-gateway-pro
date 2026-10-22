import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import type { PoolClient } from 'pg';
import { getPool, withTransaction } from './pool';

const SQL_DIR = path.join(__dirname, 'sql');
const LOCK_KEY = 918_273_645; // arbitrary, stable advisory lock id

export type MigrationResult = {
  applied: string[];
  skipped: string[];
};

async function ensureMigrationTable(client: PoolClient): Promise<void> {
  await client.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      filename    TEXT PRIMARY KEY,
      checksum    TEXT NOT NULL,
      applied_at  TIMESTAMPTZ NOT NULL DEFAULT now()
    )`);
}

export async function runMigrations(options: { log?: (msg: string) => void } = {}): Promise<MigrationResult> {
  const log = options.log ?? (() => {});
  const pool = getPool();
  const client = await pool.connect();
  const result: MigrationResult = { applied: [], skipped: [] };
  try {
    await client.query('SELECT pg_advisory_lock($1)', [LOCK_KEY]);
    await ensureMigrationTable(client);
    const files = (await readdir(SQL_DIR)).filter((f) => f.endsWith('.sql')).sort();
    const existing = await client.query<{ filename: string; checksum: string }>(
      'SELECT filename, checksum FROM schema_migrations',
    );
    const appliedMap = new Map(existing.rows.map((r) => [r.filename, r.checksum]));

    for (const file of files) {
      const sql = await readFile(path.join(SQL_DIR, file), 'utf8');
      const checksum = createHash('sha256').update(sql).digest('hex');
      const previous = appliedMap.get(file);
      if (previous) {
        if (previous !== checksum) {
          throw new Error(
            `Migration ${file} was modified after being applied. Migrations are immutable — add a new file instead.`,
          );
        }
        result.skipped.push(file);
        continue;
      }
      log(`applying ${file}`);
      await withTransaction(async (tx) => {
        await tx.query(sql);
        await tx.query('INSERT INTO schema_migrations (filename, checksum) VALUES ($1, $2)', [
          file,
          checksum,
        ]);
      });
      result.applied.push(file);
    }
    return result;
  } finally {
    await client.query('SELECT pg_advisory_unlock($1)', [LOCK_KEY]).catch(() => undefined);
    client.release();
  }
}
