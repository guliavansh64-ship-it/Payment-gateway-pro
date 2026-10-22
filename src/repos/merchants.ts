import type { PoolClient } from 'pg';
import { one, query } from '../db/pool';
import type { Merchant } from '../domain/models';

type MerchantRow = {
  id: string;
  owner_id: string;
  merchant_code: string;
  business_name: string;
  verified_merchant_upi_id: string | null;
  upi_verified_at: Date | null;
  provider_account_id: string | null;
  account_status: Merchant['accountStatus'];
  late_payment_policy: Merchant['latePaymentPolicy'];
  default_provider: string | null;
  branding_color: string;
  support_email: string | null;
  created_at: Date;
};

function mapMerchant(row: MerchantRow): Merchant {
  return {
    id: row.id,
    ownerId: row.owner_id,
    merchantCode: row.merchant_code,
    businessName: row.business_name,
    verifiedMerchantUpiId: row.verified_merchant_upi_id,
    upiVerifiedAt: row.upi_verified_at,
    providerAccountId: row.provider_account_id,
    accountStatus: row.account_status,
    latePaymentPolicy: row.late_payment_policy,
    defaultProvider: row.default_provider,
    brandingColor: row.branding_color,
    supportEmail: row.support_email,
    createdAt: row.created_at,
  };
}

const COLUMNS = `id, owner_id, merchant_code, business_name, verified_merchant_upi_id, upi_verified_at,
  provider_account_id, account_status, late_payment_policy, default_provider, branding_color,
  support_email, created_at`;

export async function findMerchantById(id: string): Promise<Merchant | null> {
  const row = await one<MerchantRow>(`SELECT ${COLUMNS} FROM merchants WHERE id = $1`, [id]);
  return row ? mapMerchant(row) : null;
}

export async function findMerchantByOwner(
  ownerId: string,
  client?: PoolClient,
): Promise<Merchant | null> {
  const sql = `SELECT ${COLUMNS} FROM merchants WHERE owner_id = $1 ORDER BY created_at LIMIT 1`;
  if (client) {
    const res = await client.query<MerchantRow>(sql, [ownerId]);
    return res.rows[0] ? mapMerchant(res.rows[0]) : null;
  }
  const row = await one<MerchantRow>(sql, [ownerId]);
  return row ? mapMerchant(row) : null;
}

export async function listMerchants(): Promise<Merchant[]> {
  const res = await query<MerchantRow>(`SELECT ${COLUMNS} FROM merchants ORDER BY business_name`);
  return res.rows.map(mapMerchant);
}

export async function createMerchant(input: {
  ownerId: string;
  merchantCode: string;
  businessName: string;
  verifiedMerchantUpiId?: string | null;
  defaultProvider?: string | null;
  brandingColor?: string;
  supportEmail?: string | null;
  accountStatus?: Merchant['accountStatus'];
}): Promise<Merchant> {
  const row = await one<MerchantRow>(
    `INSERT INTO merchants (owner_id, merchant_code, business_name, verified_merchant_upi_id,
                            upi_verified_at, default_provider, branding_color, support_email, account_status)
     VALUES ($1, $2, $3, $4, CASE WHEN $4::text IS NULL THEN NULL ELSE now() END, $5, $6, $7, $8)
     RETURNING ${COLUMNS}`,
    [
      input.ownerId,
      input.merchantCode,
      input.businessName,
      input.verifiedMerchantUpiId ?? null,
      input.defaultProvider ?? null,
      input.brandingColor ?? '#0f766e',
      input.supportEmail ?? null,
      input.accountStatus ?? 'PENDING',
    ],
  );
  if (!row) throw new Error('Failed to create merchant');
  return mapMerchant(row);
}

/**
 * Verifying a merchant UPI ID is a privileged, auditable action: the operator
 * attests that they validated the VPA out-of-band with the merchant.
 */
export async function setVerifiedUpiId(input: {
  merchantId: string;
  upiId: string | null;
  verifiedBy: string;
}): Promise<Merchant> {
  const row = await one<MerchantRow>(
    `UPDATE merchants
        SET verified_merchant_upi_id = $2,
            upi_verified_at = CASE WHEN $2::text IS NULL THEN NULL ELSE now() END,
            upi_verified_by = CASE WHEN $2::text IS NULL THEN NULL ELSE $3::uuid END
      WHERE id = $1
      RETURNING ${COLUMNS}`,
    [input.merchantId, input.upiId, input.verifiedBy],
  );
  if (!row) throw new Error('Merchant not found');
  return mapMerchant(row);
}

export async function setAccountStatus(
  merchantId: string,
  status: Merchant['accountStatus'],
): Promise<void> {
  await query('UPDATE merchants SET account_status = $2 WHERE id = $1', [merchantId, status]);
}

export async function setLatePaymentPolicy(
  merchantId: string,
  policy: Merchant['latePaymentPolicy'],
): Promise<void> {
  await query('UPDATE merchants SET late_payment_policy = $2 WHERE id = $1', [merchantId, policy]);
}

/** Finds the merchant that claims a given verified UPI ID (for email matching). */
export async function findMerchantByVerifiedUpi(vpa: string): Promise<Merchant | null> {
  const row = await one<MerchantRow>(
    `SELECT ${COLUMNS} FROM merchants WHERE lower(verified_merchant_upi_id) = lower($1) LIMIT 1`,
    [vpa],
  );
  return row ? mapMerchant(row) : null;
}
