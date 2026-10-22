import { Router } from 'express';
import { z } from 'zod';
import { AppError } from '../../errors';
import { formatPaise } from '../../domain/money';
import { isOrderIdFormat, normalizeOrderId } from '../../domain/ids';
import { writeAudit } from '../../repos/ops';
import { findOrderByOrderId } from '../../repos/orders';
import { providerPublicInfo } from '../../providers/registry';
import { asyncHandler, clientIpHash, requireAuth } from '../middleware';
import { requireCsrf } from '../session';
import { createOrder } from '../../services/orders';
import { verifyOrderWithProvider } from '../../services/payments';
import { loadMerchantForRequest } from './scope';

/**
 * Small JSON API for authenticated merchants.
 *
 * There is deliberately no public, key-based API: every mutation requires a
 * session, CSRF token and role check. Payment status reads are provider-backed.
 */
export function apiRouter(): Router {
  const router = Router();

  const createOrderSchema = z.object({
    amount: z.string().regex(/^\d{1,9}(\.\d{1,2})?$/),
    description: z.string().max(200).optional(),
    payment_method: z.enum(['UPI_QR', 'UPI_ID', 'UPI_INTENT']).default('UPI_QR'),
    provider: z.string().max(40).optional(),
    customer_reference: z.string().max(80).optional(),
    expires_in_minutes: z.coerce.number().int().min(2).max(1440).optional(),
  });

  router.post(
    '/orders',
    requireAuth(['MERCHANT_ADMIN', 'ADMIN']),
    requireCsrf,
    asyncHandler(async (req, res) => {
      const merchant = await loadMerchantForRequest(req, req.body?.merchant_id);
      if (!merchant) throw new AppError('FORBIDDEN', 'No merchant account', 403);
      if (merchant.accountStatus !== 'ACTIVE') {
        throw new AppError('FORBIDDEN', 'Merchant account is not active', 403);
      }
      const parsed = createOrderSchema.safeParse(req.body);
      if (!parsed.success) {
        throw new AppError('VALIDATION_ERROR', parsed.error.issues.map((i) => i.message).join('; '), 400);
      }
      const { order } = await createOrder(
        {
          merchantId: merchant.id,
          amountRupees: parsed.data.amount,
          description: parsed.data.description ?? null,
          paymentMethod: parsed.data.payment_method,
          providerName: parsed.data.provider,
          customerReference: parsed.data.customer_reference ?? null,
          expiresInMinutes: parsed.data.expires_in_minutes,
        },
        { actorId: req.auth!.user.id, actorType: 'USER', ipHash: clientIpHash(req) },
      );
      await writeAudit({
        actorId: req.auth!.user.id,
        actorType: 'USER',
        action: 'ORDER_CREATED_VIA_API',
        resourceType: 'payment_order',
        resourceId: order.orderId,
        metadata: { amount_paise: order.amountPaise, provider: order.providerName },
        ipHash: clientIpHash(req),
      });
      res.status(201).json({
        order_id: order.orderId,
        status: order.status,
        amount_paise: order.amountPaise,
        amount: formatPaise(order.amountPaise),
        currency: order.currency,
        payment_method: order.paymentMethod,
        provider: order.providerName,
        expires_at: order.expiresAt.toISOString(),
        payment_url: `/pay/${order.orderId}?t=${encodeURIComponent(order.publicToken)}`,
      });
    }),
  );

  router.get(
    '/orders/:orderId',
    requireAuth(['MERCHANT_ADMIN', 'ADMIN', 'AUDITOR']),
    asyncHandler(async (req, res) => {
      const orderId = normalizeOrderId(String(req.params.orderId ?? ''));
      if (!isOrderIdFormat(orderId)) throw new AppError('VALIDATION_ERROR', 'Invalid order id', 400);
      const order = await findOrderByOrderId(orderId);
      if (!order) throw new AppError('NOT_FOUND', 'Order not found', 404);
      const merchant = await loadMerchantForRequest(req, order.merchantId);
      if (!merchant || merchant.id !== order.merchantId) {
        throw new AppError('FORBIDDEN', 'Order belongs to another merchant', 403);
      }
      res.json({
        order_id: order.orderId,
        status: order.status,
        verification_status: order.verificationStatus,
        amount_paise: order.amountPaise,
        paid_amount_paise: order.paidAmountPaise,
        currency: order.currency,
        provider: order.providerName,
        created_at: order.createdAt.toISOString(),
        expires_at: order.expiresAt.toISOString(),
        paid_at: order.paidAt?.toISOString() ?? null,
        verification_source: order.verificationSource,
      });
    }),
  );

  router.post(
    '/orders/:orderId/verify',
    requireAuth(['MERCHANT_ADMIN', 'ADMIN']),
    requireCsrf,
    asyncHandler(async (req, res) => {
      const orderId = normalizeOrderId(String(req.params.orderId ?? ''));
      const order = await findOrderByOrderId(orderId);
      if (!order) throw new AppError('NOT_FOUND', 'Order not found', 404);
      const merchant = await loadMerchantForRequest(req, order.merchantId);
      if (!merchant || merchant.id !== order.merchantId) {
        throw new AppError('FORBIDDEN', 'Order belongs to another merchant', 403);
      }
      const result = await verifyOrderWithProvider(order, {
        trigger: 'RECONCILIATION',
        ipHash: clientIpHash(req),
      });
      res.json({
        order_id: result.order.orderId,
        status: result.order.status,
        verification_status: result.order.verificationStatus,
        provider_outcome: result.kind,
      });
    }),
  );

  router.get(
    '/providers',
    requireAuth(['MERCHANT_ADMIN', 'ADMIN', 'AUDITOR']),
    (_req, res) => {
      res.json(
        providerPublicInfo().map((p) => ({
          name: p.name,
          display_name: p.displayName,
          configured: p.configured,
          simulated: p.simulated,
          capabilities: p.capabilities,
        })),
      );
    },
  );

  return router;
}
