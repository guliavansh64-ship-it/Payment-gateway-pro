import './setup/env';
import { runMigrations } from '../src/db/migrate';

/** Creates the schema once for the whole run. */
export default async function setup(): Promise<void> {
  const result = await runMigrations();
  if (result.applied.length > 0) {
    // eslint-disable-next-line no-console
    console.log(`[tests] applied migrations: ${result.applied.join(', ')}`);
  }
  const { closePool } = await import('../src/db/pool');
  await closePool();
}
