import 'dotenv/config';
import { closePool, query } from './pool';
import { createUser, findUserByEmail } from '../repos/accounts';
import { createMerchant, findMerchantByOwner, setVerifiedUpiId } from '../repos/merchants';
import { upsertProviderConfig } from '../repos/ops';
import { hashPassword } from '../security/crypto';
import { getConfig } from '../config';

/**
 * Local development seed.
 *
 * Creates one administrator and one merchant. Passwords are development
 * placeholders printed once and must be changed. Never run in production.
 */
const DEFAULT_PASSWORD = 'ChangeMeNow!2026';

async function main(): Promise<void> {
  const config = getConfig();
  if (config.isProduction) throw new Error('Refusing to seed a production database');

  const adminEmail = process.env.SEED_ADMIN_EMAIL ?? 'admin@upiverify.test';
  const merchantEmail = process.env.SEED_MERCHANT_EMAIL ?? 'merchant@upiverify.test';
  const password = process.env.SEED_PASSWORD ?? DEFAULT_PASSWORD;

  let admin = await findUserByEmail(adminEmail);
  if (!admin) {
    const user = await createUser({
      name: 'Platform Admin',
      email: adminEmail,
      role: 'ADMIN',
      passwordHash: await hashPassword(password),
    });
    console.log(`[seed] created admin ${user.email}`);
  } else {
    console.log('[seed] admin already exists');
  }

  let merchantUser = await findUserByEmail(merchantEmail);
  if (!merchantUser) {
    const user = await createUser({
      name: 'Aarav Sharma',
      email: merchantEmail,
      role: 'MERCHANT_ADMIN',
      passwordHash: await hashPassword(password),
    });
    merchantUser = { user, passwordHash: null };
    console.log(`[seed] created merchant user ${user.email}`);
  }

  let merchant = await findMerchantByOwner(merchantUser.user.id);
  if (!merchant) {
    merchant = await createMerchant({
      ownerId: merchantUser.user.id,
      merchantCode: 'MERCHANT-1001',
      businessName: 'Aarav Traders',
      defaultProvider: config.allowSandboxProvider ? 'sandbox' : 'manual_upi',
      brandingColor: '#0f766e',
      supportEmail: 'support@aarav.example',
      accountStatus: 'PENDING',
    });
    console.log(`[seed] created merchant ${merchant.merchantCode}`);
  }

  if (!merchant.verifiedMerchantUpiId && admin) {
    await setVerifiedUpiId({
      merchantId: merchant.id,
      upiId: 'aarav.traders@okhdfcbank',
      verifiedBy: admin.user.id,
    });
    console.log('[seed] verified merchant UPI ID (development only)');
  }

  const { setAccountStatus } = await import('../repos/merchants');
  await setAccountStatus(merchant.id, 'ACTIVE');

  await upsertProviderConfig({
    providerName: 'sandbox',
    enabled: config.allowSandboxProvider,
    mode: 'test',
    updatedBy: admin?.user.id ?? merchantUser.user.id,
  });
  await query(
    `INSERT INTO provider_configs (provider_name, enabled, mode)
     VALUES ('manual_upi', TRUE, 'live'), ('razorpay', FALSE, 'test'), ('cashfree', FALSE, 'sandbox')
     ON CONFLICT (provider_name) DO NOTHING`,
  );

  console.log('\n[seed] development credentials');
  console.log(`  admin:    ${adminEmail} / ${password}`);
  console.log(`  merchant: ${merchantEmail} / ${password}`);
  console.log('  Change these immediately outside local development.\n');
}

main()
  .then(() => closePool())
  .catch(async (err) => {
    console.error('[seed] failed:', err);
    await closePool();
    process.exit(1);
  });
