import { randomBytes, randomUUID } from 'node:crypto';
import { query } from '../../src/db/pool';
import { createUser } from '../../src/repos/accounts';
import { createMerchant, setVerifiedUpiId } from '../../src/repos/merchants';
import { upsertProviderConfig } from '../../src/repos/ops';
import { createOrder } from '../../src/services/orders';
import { hashPassword, opaqueHash } from '../../src/security/crypto';
import { createSession } from '../../src/repos/accounts';
import { SandboxProvider } from '../../src/providers/sandbox';
import type { Merchant, Order, User } from '../../src/domain/models';
import type { PaymentMethod } from '../../src/domain/models';

export const TEST_PASSWORD = 'CorrectHorseBattery9';
export const MERCHANT_VPA = 'aarav.traders@okhdfcbank';

export async function makeUser(
  overrides: Partial<{ role: User['role']; email: string; name: string }> = {},
): Promise<User> {
  return createUser({
    name: overrides.name ?? 'Test User',
    email: overrides.email ?? `user-${randomUUID().slice(0, 8)}@example.test`,
    role: overrides.role ?? 'MERCHANT_ADMIN',
    passwordHash: await hashPassword(TEST_PASSWORD),
  });
}

export async function makeMerchant(overrides: {
  ownerId: string;
  upi?: string | null;
  defaultProvider?: string;
  accountStatus?: Merchant['accountStatus'];
  businessName?: string;
  merchantCode?: string;
}): Promise<Merchant> {
  const merchant = await createMerchant({
    ownerId: overrides.ownerId,
    merchantCode: overrides.merchantCode ?? `MERCHANT-${Math.floor(100000 + Math.random() * 899999)}`,
    businessName: overrides.businessName ?? 'Test Merchant',
    defaultProvider: overrides.defaultProvider ?? 'sandbox',
    accountStatus: overrides.accountStatus ?? 'ACTIVE',
  });
  if (overrides.upi !== null) {
    await setVerifiedUpiId({
      merchantId: merchant.id,
      upiId: overrides.upi ?? MERCHANT_VPA,
      verifiedBy: overrides.ownerId,
    });
  }
  await upsertProviderConfig({
    providerName: 'sandbox',
    enabled: true,
    mode: 'test',
    updatedBy: overrides.ownerId,
  });
  return merchant;
}

export async function makeOrder(input: {
  merchantId: string;
  amountPaise?: number;
  provider?: string;
  paymentMethod?: PaymentMethod;
  expiresInMinutes?: number;
  createdAt?: Date;
}): Promise<Order> {
  const { order } = await createOrder(
    {
      merchantId: input.merchantId,
      amountPaise: input.amountPaise ?? 49900,
      paymentMethod: input.paymentMethod ?? 'UPI_QR',
      providerName: input.provider ?? 'sandbox',
      expiresInMinutes: input.expiresInMinutes ?? 15,
    },
    { actorId: null, actorType: 'SYSTEM' },
  );
  if (input.createdAt) {
    await query('UPDATE payment_orders SET created_at = $2 WHERE id = $1', [order.id, input.createdAt]);
  }
  return order;
}

/** Back-dates an order so it is expired without waiting. */
export async function expireOrder(order: Order): Promise<void> {
  await query(
    `UPDATE payment_orders
        SET created_at = now() - interval '30 minutes',
            expires_at = now() - interval '5 minutes'
      WHERE id = $1`,
    [order.id],
  );
}

export function sandboxEvent(
  order: Order,
  overrides: {
    eventId?: string;
    status?: 'SUCCESS' | 'FAILED' | 'PENDING' | 'REVERSED';
    amountPaise?: number;
    reference?: string;
    payeeVpa?: string | null;
    orderReference?: string | null;
    providerPaymentId?: string | null;
    paidAt?: string | null;
  } = {},
): Record<string, unknown> {
  const status = overrides.status ?? 'SUCCESS';
  return {
    event_id: overrides.eventId ?? `sbx_${randomUUID()}`,
    event_type: `payment.${status.toLowerCase()}`,
    provider_payment_id:
      overrides.providerPaymentId === undefined ? order.providerPaymentId : overrides.providerPaymentId,
    order_reference: overrides.orderReference === undefined ? order.orderId : overrides.orderReference,
    amount_paise: overrides.amountPaise ?? order.amountPaise,
    currency: 'INR',
    status,
    paid_at: overrides.paidAt === undefined ? new Date().toISOString() : overrides.paidAt,
    provider_transaction_reference:
      overrides.reference ?? `SBX${Math.floor(100000000 + Math.random() * 899999999)}`,
    payee_vpa:
      overrides.payeeVpa === undefined ? (order.upiPayeeVpa ?? 'sandbox.merchant@upi') : overrides.payeeVpa,
    failure_reason: status === 'FAILED' ? 'Simulated decline' : null,
  };
}

export function signedSandboxEvent(
  order: Order,
  overrides: Parameters<typeof sandboxEvent>[1] = {},
): { body: string; signature: string; payload: Record<string, unknown> } {
  const payload = sandboxEvent(order, overrides);
  const signed = SandboxProvider.buildSignedEvent(payload);
  return { ...signed, payload };
}

export async function makeSession(user: User): Promise<{ cookie: string; csrfToken: string }> {
  const token = randomBytes(32).toString('base64url');
  const csrfToken = randomBytes(24).toString('base64url');
  await createSession({
    userId: user.id,
    tokenHash: opaqueHash(token),
    csrfTokenHash: opaqueHash(csrfToken),
    ipHash: 'test',
    userAgentHash: 'vitest',
    expiresAt: new Date(Date.now() + 60 * 60_000),
  });
  return { cookie: `sid=${token}; csrf=${csrfToken}`, csrfToken };
}

export async function countRows(table: string): Promise<number> {
  const res = await query<{ count: string }>(`SELECT count(*)::text AS count FROM ${table}`);
  return Number(res.rows[0]?.count ?? 0);
}

export async function latestCase(): Promise<{
  id: string;
  reason: string;
  resolution_status: string;
  candidate_transaction_id: string | null;
} | null> {
  const res = await query<{
    id: string;
    reason: string;
    resolution_status: string;
    candidate_transaction_id: string | null;
  }>(
    `SELECT id, reason, resolution_status, candidate_transaction_id
       FROM reconciliation_cases ORDER BY created_at DESC LIMIT 1`,
  );
  return res.rows[0] ?? null;
}

export async function insertSandboxPayment(input: {
  providerPaymentId: string;
  orderReference: string;
  status?: 'SUCCESS' | 'FAILED' | 'PENDING' | 'REVERSED';
  amountPaise: number;
  reference?: string;
  /** Payee recorded on the simulated payment; defaults to the sandbox VPA. */
  payeeVpa?: string | null;
  paidAt?: Date | null;
}): Promise<void> {
  await query(
    `INSERT INTO sandbox_payments
       (provider_payment_id, order_reference, status, amount_paise,
        provider_transaction_reference, payee_vpa, paid_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7)
     ON CONFLICT (provider_payment_id) DO UPDATE
       SET status = EXCLUDED.status,
           amount_paise = EXCLUDED.amount_paise,
           provider_transaction_reference = EXCLUDED.provider_transaction_reference`,
    [
      input.providerPaymentId,
      input.orderReference,
      input.status ?? 'SUCCESS',
      input.amountPaise,
      input.reference ?? `SBX${Math.floor(100000000 + Math.random() * 899999999)}`,
      input.payeeVpa === undefined ? 'sandbox.merchant@upi' : input.payeeVpa,
      input.paidAt === undefined ? new Date() : input.paidAt,
    ],
  );
}
