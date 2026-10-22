import 'dotenv/config';
import { closePool } from './pool';
import { runMigrations } from './migrate';

async function main(): Promise<void> {
  const result = await runMigrations({ log: (m) => console.log(`[migrate] ${m}`) });
  console.log(
    `[migrate] applied ${result.applied.length} migration(s); ${result.skipped.length} already present.`,
  );
}

main()
  .then(() => closePool())
  .catch(async (err) => {
    console.error('[migrate] failed:', err);
    await closePool();
    process.exit(1);
  });
