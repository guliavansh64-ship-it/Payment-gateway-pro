import type { Request } from 'express';
import type { Merchant } from '../../domain/models';
import { findMerchantById, findMerchantByOwner } from '../../repos/merchants';

/**
 * Resolves which merchant a request is allowed to see.
 *
 *  - MERCHANT_ADMIN: always their own merchant, regardless of parameters
 *  - ADMIN / AUDITOR: may pass ?merchant=<uuid>; otherwise they get cross-
 *    merchant views that callers must handle explicitly
 */
export async function loadMerchantForRequest(
  req: Request,
  merchantIdOverride?: unknown,
): Promise<Merchant | null> {
  if (!req.auth) return null;
  const role = req.auth.user.role;
  if (role === 'MERCHANT_ADMIN' || role === 'USER') {
    return findMerchantByOwner(req.auth.user.id);
  }
  if (role === 'ADMIN' || role === 'AUDITOR') {
    const id =
      typeof merchantIdOverride === 'string' && merchantIdOverride.length > 0
        ? merchantIdOverride
        : typeof req.query.merchant === 'string'
          ? req.query.merchant
          : null;
    if (id) return findMerchantById(id);
    return null;
  }
  return null;
}

/** Throws unless the caller may view this merchant's data. */
export async function assertMerchantAccess(req: Request, merchantId: string): Promise<Merchant> {
  const merchant = await loadMerchantForRequest(req, merchantId);
  if (!merchant || merchant.id !== merchantId) {
    const { AppError } = await import('../../errors');
    throw new AppError('FORBIDDEN', 'You cannot access this merchant', 403);
  }
  return merchant;
}
