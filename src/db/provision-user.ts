import 'dotenv/config';
import { createUser, findUserByEmail } from '../repos/accounts';
import { hashPassword } from '../security/crypto';
import { closePool } from './pool';
import { getConfig } from '../config';
import type { UserRole } from '../domain/models';

/**
 * Provisioning CLI.
 *
 *   node dist/db/provision-user.js --email ops@example.com --name "Ops" \
 *        --role ADMIN --password-env ADMIN_PASSWORD
 *
 * The password is read from the environment (or stdin), never from argv, so it
 * does not leak into shell history or process listings.
 */
async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const get = (flag: string): string | undefined => {
    const i = args.indexOf(flag);
    return i >= 0 ? args[i + 1] : undefined;
  };
  const email = get('--email');
  const name = get('--name') ?? 'Operator';
  const role = (get('--role') ?? 'MERCHANT_ADMIN') as UserRole;
  const password = process.env.PROVISION_PASSWORD;

  if (!email || !password) {
    throw new Error('Usage: --email <email> --name <name> --role <role> (PROVISION_PASSWORD env required)');
  }
  if (!['USER', 'MERCHANT_ADMIN', 'ADMIN', 'AUDITOR'].includes(role)) {
    throw new Error('Invalid role');
  }
  if ((await findUserByEmail(email)) && !args.includes('--force')) {
    throw new Error('User already exists (pass --force to reset the password)');
  }
  const passwordHash = await hashPassword(password);
  const existing = await findUserByEmail(email);
  if (existing && args.includes('--force')) {
    const { getPool } = await import('./pool');
    await getPool().query('UPDATE users SET password_hash = $2, role = $3, is_active = TRUE WHERE id = $1', [
      existing.user.id,
      passwordHash,
      role,
    ]);
    console.log(`[provision] password reset for ${email} (role ${role})`);
  } else {
    const user = await createUser({ name, email, role, passwordHash });
    console.log(`[provision] created ${user.email} (${user.role})`);
  }
  console.log('[provision] remember to enable MFA at the identity layer for ADMIN accounts.');
  if (getConfig().isProduction) console.log('[provision] production: store the password in a secret manager first.');
}

main()
  .then(() => closePool())
  .catch(async (err) => {
    console.error('[provision] failed:', err instanceof Error ? err.message : err);
    await closePool();
    process.exit(1);
  });
