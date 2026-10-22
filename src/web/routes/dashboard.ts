import { Router } from 'express';
import { z } from 'zod';
import { AppError } from '../../errors';
import { getConfig } from '../../config';
import { formatPaise, parseRupeesToPaise } from '../../domain/money';
import { isOrderIdFormat, normalizeOrderId } from '../../domain/ids';
import { ORDER_STATUSES, type OrderStatus } from '../../domain/status';
import { getLogger } from '../../observability/logger';
import * as ledger from '../../repos/ledger';
import * as merchantRepo from '../../repos/merchants';
import * as orderRepo from '../../repos/orders';
import * as ops from '../../repos/ops';
import { providerPublicInfo } from '../../providers/registry';
import { asyncHandler, clientIpHash, loadMerchant, requireAuth, requireStepUp } from '../middleware';
import { requireCsrf } from '../session';
import { getOrderDetail } from '../../services/orders';
import { approveReviewCase, assignCaseToOrder, rejectReviewCase } from '../../services/review';
import { requestRefund } from '../../services/refunds';
import { loadMerchantForRequest } from './scope';

/**
 * Merchant dashboard.
 *
 * Merchant admins are hard-scoped to their own merchant: the merchant id from
 * the session always wins over any parameter. Admins see cross-merchant data.
 */

const REQUIRED_ROLES = ['MERCHANT_ADMIN', 'ADMIN', 'AUDITOR'] as const;

export function dashboardRouter(): Router {
  const router = Router();
  router.use(requireAuth([...REQUIRED_ROLES]), loadMerchant());

  router.get(
    '/',
    asyncHandler(async (req, res) => {
      const merchant = await loadMerchantForRequest(req);
      const stats = merchant
        ? await orderRepo.merchantStats(merchant.id)
        : await orderRepo.globalStats();
      const [recent, cases, gmail, providerConfigs] = await Promise.all([
        orderRepo.listOrders({ merchantId: merchant?.id, limit: 8 }),
        ops.listReconciliationCases({ merchantId: merchant?.id, status: 'OPEN', limit: 5 }),
        ops.findGmailConnectionByUser(req.auth!.user.id),
        ops.listProviderConfigs(),
      ]);
      const runs = req.auth!.user.role === 'ADMIN' ? await ops.listRecentRuns(6) : [];
      res.render('dashboard/home', {
        title: 'Dashboard',
        merchant,
        stats,
        recentOrders: recent.rows,
        openCases: cases.rows,
        openCaseCount: cases.total,
        gmail,
        providers: providerPublicInfo(),
        providerConfigs,
        runs,
      });
    }),
  );

  router.get(
    '/orders',
    asyncHandler(async (req, res) => {
      const merchant = await loadMerchantForRequest(req);
      const status = parseStatusFilter(req.query.status);
      const search = typeof req.query.q === 'string' ? req.query.q.slice(0, 80) : undefined;
      const from = parseDate(req.query.from);
      const to = parseDate(req.query.to);
      const page = Math.max(1, Number.parseInt(String(req.query.page ?? '1'), 10) || 1);
      const limit = 25;
      const result = await orderRepo.listOrders({
        merchantId: merchant?.id,
        status,
        search,
        from,
        to,
        limit,
        offset: (page - 1) * limit,
      });
      res.render('dashboard/orders', {
        title: 'Payment requests',
        merchant,
        orders: result.rows,
        total: result.total,
        page,
        pages: Math.max(1, Math.ceil(result.total / limit)),
        filters: {
          status: status ?? [],
          q: search ?? '',
          from: typeof req.query.from === 'string' ? req.query.from : '',
          to: typeof req.query.to === 'string' ? req.query.to : '',
        },
        statuses: ORDER_STATUSES,
      });
    }),
  );

  router.get(
    '/orders/:orderId',
    asyncHandler(async (req, res) => {
      const orderId = normalizeOrderId(String(req.params.orderId ?? ''));
      if (!isOrderIdFormat(orderId)) throw new AppError('VALIDATION_ERROR', 'Invalid order id', 400);
      const order = await orderRepo.findOrderByOrderId(orderId);
      if (!order) throw new AppError('NOT_FOUND', 'Order not found', 404);
      const merchant = await loadMerchantForRequest(req, order.merchantId);
      if (!merchant || merchant.id !== order.merchantId) {
        throw new AppError('FORBIDDEN', 'Order belongs to another merchant', 403);
      }
      const detail = await getOrderDetail(order.id);
      if (!detail) throw new AppError('NOT_FOUND', 'Order not found', 404);
      const cases = await ops.listCasesForOrder(order.id);
      res.render('dashboard/order', {
        title: `Order ${order.orderId}`,
        order: detail.order,
        merchant: detail.merchant,
        history: detail.history,
        transactions: detail.transactions,
        events: detail.events,
        refunds: detail.refunds,
        cases,
        paymentUrl: absoluteUrl(req, `/pay/${order.orderId}?t=${encodeURIComponent(order.publicToken)}`),
        canRefund:
          req.auth!.user.role === 'ADMIN' &&
          ['PAID', 'LATE_PAYMENT', 'PARTIALLY_REFUNDED', 'REFUND_PENDING'].includes(order.status) &&
          Boolean(order.paidAmountPaise) &&
          order.refundedPaise < (order.paidAmountPaise ?? 0),
        refundablePaise: Math.max(0, (order.paidAmountPaise ?? 0) - order.refundedPaise),
      });
    }),
  );

  router.post(
    '/orders/:orderId/verify',
    requireAuth([...REQUIRED_ROLES]),
    requireCsrf,
    asyncHandler(async (req, res) => {
      const orderId = normalizeOrderId(String(req.params.orderId ?? ''));
      const order = await orderRepo.findOrderByOrderId(orderId);
      if (!order) throw new AppError('NOT_FOUND', 'Order not found', 404);
      const merchant = await loadMerchantForRequest(req, order.merchantId);
      if (!merchant || merchant.id !== order.merchantId) {
        throw new AppError('FORBIDDEN', 'Order belongs to another merchant', 403);
      }
      const { verifyOrderWithProvider } = await import('../../services/payments');
      const result = await verifyOrderWithProvider(order, {
        trigger: 'RECONCILIATION',
        ipHash: clientIpHash(req),
      });
      res.redirect(
        `/dashboard/orders/${orderId}?notice=${result.kind === 'CONFIRMED' ? 'review-approved' : 'provider-checked'}`,
      );
    }),
  );

  router.post(
    '/orders/:orderId/refund',
    requireAuth(['ADMIN']),
    requireStepUp(),
    requireCsrf,
    asyncHandler(async (req, res) => {
      const orderId = normalizeOrderId(String(req.params.orderId ?? ''));
      const order = await orderRepo.findOrderByOrderId(orderId);
      if (!order) throw new AppError('NOT_FOUND', 'Order not found', 404);
      const schema = z.object({
        amount: z.string().regex(/^\d{1,9}(\.\d{1,2})?$/),
        reason_code: z.enum(['DUPLICATE', 'FRAUDULENT', 'REQUESTED_BY_CUSTOMER', 'LATE_PAYMENT', 'AMOUNT_MISMATCH', 'OTHER']),
        note: z.string().min(5).max(500),
      });
      const parsed = schema.safeParse(req.body);
      if (!parsed.success) {
        return res.redirect(`/dashboard/orders/${orderId}?error=invalid-input`);
      }
      const amountPaise = parseRupeesToPaise(parsed.data.amount);
      try {
        await requestRefund({
          orderPk: order.id,
          amountPaise,
          reasonCode: parsed.data.reason_code,
          note: parsed.data.note,
          adminId: req.auth!.user.id,
          ipHash: clientIpHash(req),
        });
        res.redirect(`/dashboard/orders/${orderId}?notice=refund-created`);
      } catch (err) {
        getLogger().warn('refund failed', { orderId, error: err instanceof Error ? err.message : String(err) });
        res.redirect(`/dashboard/orders/${orderId}?error=provider-failed`);
      }
    }),
  );

  router.post(
    '/refunds/:refundId/reconcile',
    requireAuth(['ADMIN']),
    requireCsrf,
    asyncHandler(async (req, res) => {
      const { reconcileRefund } = await import('../../services/refunds');
      try {
        await reconcileRefund({ refundId: String(req.params.refundId), adminId: req.auth!.user.id, ipHash: clientIpHash(req) });
        res.redirect(`/dashboard/orders/${String(req.body.order_id ?? '')}?notice=refund-reconciled`);
      } catch {
        res.redirect(`/dashboard/orders/${String(req.body.order_id ?? '')}?error=provider-failed`);
      }
    }),
  );

  router.get(
    '/transactions',
    asyncHandler(async (req, res) => {
      const merchant = await loadMerchantForRequest(req);
      const search = typeof req.query.q === 'string' ? req.query.q.slice(0, 80) : undefined;
      const verification = typeof req.query.verification === 'string' ? req.query.verification : undefined;
      const page = Math.max(1, Number.parseInt(String(req.query.page ?? '1'), 10) || 1);
      const limit = 25;
      const result = await ledger.listTransactions({
        merchantId: merchant?.id,
        verificationStatus: verification as never,
        search,
        limit,
        offset: (page - 1) * limit,
      });
      res.render('dashboard/transactions', {
        title: 'Transactions',
        merchant,
        transactions: result.rows,
        total: result.total,
        page,
        pages: Math.max(1, Math.ceil(result.total / limit)),
        filters: { q: search ?? '', verification: verification ?? '' },
      });
    }),
  );

  router.get(
    '/review',
    asyncHandler(async (req, res) => {
      const merchant = await loadMerchantForRequest(req);
      const result = await ops.listReconciliationCases({
        merchantId: merchant?.id,
        status: 'OPEN',
        limit: 50,
      });
      res.render('dashboard/review', {
        title: 'Manual review',
        merchant,
        cases: result.rows,
        total: result.total,
      });
    }),
  );

  router.get(
    '/review/:caseId',
    asyncHandler(async (req, res) => {
      const reviewCase = await ops.findReconciliationCase(String(req.params.caseId));
      if (!reviewCase) throw new AppError('NOT_FOUND', 'Case not found', 404);
      const merchant = await loadMerchantForRequest(req, reviewCase.merchantId);
      if (!merchant || merchant.id !== reviewCase.merchantId) {
        throw new AppError('FORBIDDEN', 'Case belongs to another merchant', 403);
      }
      const [candidate, order, possibleOrders, history] = await Promise.all([
        reviewCase.candidateTransactionId
          ? ledger.findTransactionById(reviewCase.candidateTransactionId)
          : Promise.resolve(null),
        reviewCase.orderPk ? orderRepo.findOrderByPk(reviewCase.orderPk) : Promise.resolve(null),
        Promise.all(
          reviewCase.possibleOrderIds.map((id) => orderRepo.findOrderByOrderId(id)),
        ),
        orderRepo.getStatusHistory(reviewCase.orderPk ?? '00000000-0000-0000-0000-000000000000'),
      ]);
      res.render('dashboard/case', {
        title: 'Review case',
        merchant,
        reviewCase,
        candidate,
        order,
        possibleOrders: possibleOrders.filter((o): o is NonNullable<typeof o> => Boolean(o)),
        history,
        canDecide:
          reviewCase.resolutionStatus === 'OPEN' &&
          ['ADMIN', 'MERCHANT_ADMIN'].includes(req.auth!.user.role),
      });
    }),
  );

  router.post(
    '/review/:caseId/approve',
    requireAuth(['ADMIN', 'MERCHANT_ADMIN']),
    requireStepUp(),
    requireCsrf,
    asyncHandler(async (req, res) => {
      const reviewCase = await ops.findReconciliationCase(String(req.params.caseId));
      if (!reviewCase) throw new AppError('NOT_FOUND', 'Case not found', 404);
      const merchant = await loadMerchantForRequest(req, reviewCase.merchantId);
      if (!merchant || merchant.id !== reviewCase.merchantId) {
        throw new AppError('FORBIDDEN', 'Case belongs to another merchant', 403);
      }
      try {
        await approveReviewCase({
          caseId: reviewCase.id,
          adminId: req.auth!.user.id,
          note: String(req.body.note ?? ''),
          acceptAmountMismatch: req.body.accept_mismatch === 'on',
          ipHash: clientIpHash(req),
        });
        res.redirect(`/dashboard/review/${reviewCase.id}?notice=review-approved`);
      } catch (err) {
        if (err instanceof AppError && err.code === 'AMOUNT_MISMATCH') {
          return res.redirect(`/dashboard/review/${reviewCase.id}?error=amount-mismatch`);
        }
        throw err;
      }
    }),
  );

  router.post(
    '/review/:caseId/reject',
    requireAuth(['ADMIN', 'MERCHANT_ADMIN']),
    requireCsrf,
    asyncHandler(async (req, res) => {
      const reviewCase = await ops.findReconciliationCase(String(req.params.caseId));
      if (!reviewCase) throw new AppError('NOT_FOUND', 'Case not found', 404);
      const merchant = await loadMerchantForRequest(req, reviewCase.merchantId);
      if (!merchant || merchant.id !== reviewCase.merchantId) {
        throw new AppError('FORBIDDEN', 'Case belongs to another merchant', 403);
      }
      await rejectReviewCase({
        caseId: reviewCase.id,
        adminId: req.auth!.user.id,
        note: String(req.body.note ?? ''),
        ipHash: clientIpHash(req),
      });
      res.redirect(`/dashboard/review/${reviewCase.id}?notice=review-rejected`);
    }),
  );

  router.post(
    '/review/:caseId/assign',
    requireAuth(['ADMIN', 'MERCHANT_ADMIN']),
    requireCsrf,
    asyncHandler(async (req, res) => {
      const reviewCase = await ops.findReconciliationCase(String(req.params.caseId));
      if (!reviewCase) throw new AppError('NOT_FOUND', 'Case not found', 404);
      const merchant = await loadMerchantForRequest(req, reviewCase.merchantId);
      if (!merchant || merchant.id !== reviewCase.merchantId) {
        throw new AppError('FORBIDDEN', 'Case belongs to another merchant', 403);
      }
      const orderId = normalizeOrderId(String(req.body.order_id ?? ''));
      await assignCaseToOrder({
        caseId: reviewCase.id,
        orderId,
        adminId: req.auth!.user.id,
        ipHash: clientIpHash(req),
      });
      res.redirect(`/dashboard/review/${reviewCase.id}?notice=case-assigned`);
    }),
  );

  router.get(
    '/gmail',
    asyncHandler(async (req, res) => {
      const merchant = await loadMerchantForRequest(req);
      const [connection, config] = await Promise.all([
        ops.findGmailConnectionByUser(req.auth!.user.id),
        Promise.resolve(getConfig()),
      ]);
      res.render('dashboard/gmail', {
        title: 'Gmail monitoring',
        merchant,
        connection,
        googleConfigured: Boolean(config.google.clientId && config.google.clientSecret && config.google.redirectUri),
        allowedDomains: config.gmailAllowedSenderDomains,
        errorCode: typeof req.query.error === 'string' ? req.query.error : null,
      });
    }),
  );

  router.post(
    '/gmail/disconnect',
    requireCsrf,
    asyncHandler(async (req, res) => {
      const { disconnectGmail } = await import('../../gmail/service');
      await disconnectGmail({
        userId: req.auth!.user.id,
        actorId: req.auth!.user.id,
        ipHash: clientIpHash(req),
      });
      res.redirect('/dashboard/gmail?notice=gmail-disconnected');
    }),
  );

  router.get(
    '/providers',
    asyncHandler(async (req, res) => {
      const [configs, health] = await Promise.all([ops.listProviderConfigs(), Promise.resolve(providerPublicInfo())]);
      res.render('dashboard/providers', {
        title: 'Provider integrations',
        merchant: await loadMerchantForRequest(req),
        providers: health,
        configs,
      });
    }),
  );

  router.get(
    '/reconciliation',
    requireAuth([...REQUIRED_ROLES]),
    asyncHandler(async (req, res) => {
      const merchant = await loadMerchantForRequest(req);
      const [cases, runs, refunds] = await Promise.all([
        ops.listReconciliationCases({ merchantId: merchant?.id, status: 'OPEN', limit: 50 }),
        req.auth!.user.role === 'ADMIN' ? ops.listRecentRuns(12) : Promise.resolve([]),
        Promise.resolve([]),
      ]);
      res.render('dashboard/reconciliation', {
        title: 'Reconciliation',
        merchant,
        cases: cases.rows,
        total: cases.total,
        runs,
        refunds,
      });
    }),
  );

  router.get(
    '/audit',
    requireAuth(['ADMIN', 'AUDITOR']),
    asyncHandler(async (req, res) => {
      const result = await ops.listAuditLogs({
        action: typeof req.query.action === 'string' ? req.query.action : undefined,
        limit: 100,
      });
      res.render('dashboard/audit', {
        title: 'Audit log',
        merchant: null,
        rows: result.rows,
        total: result.total,
        actionFilter: typeof req.query.action === 'string' ? req.query.action : '',
      });
    }),
  );

  router.get(
    '/export.csv',
    asyncHandler(async (req, res) => {
      const merchant = await loadMerchantForRequest(req);
      const result = await orderRepo.listOrders({ merchantId: merchant?.id, limit: 200 });
      const header = [
        'order_id',
        'created_at',
        'status',
        'verification_status',
        'amount_paise',
        'amount_inr',
        'paid_amount_paise',
        'refunded_paise',
        'provider',
        'provider_payment_id',
        'verification_source',
        'paid_at',
        'expires_at',
      ];
      const rows = result.rows.map((o) => [
        o.orderId,
        o.createdAt.toISOString(),
        o.status,
        o.verificationStatus,
        o.amountPaise,
        formatPaise(o.amountPaise),
        o.paidAmountPaise ?? '',
        o.refundedPaise,
        o.providerName,
        o.providerPaymentId ?? '',
        o.verificationSource ?? '',
        o.paidAt?.toISOString() ?? '',
        o.expiresAt.toISOString(),
      ]);
      const csv = [header, ...rows].map((r) => r.map(csvCell).join(',')).join('\r\n');
      await ops.writeAudit({
        actorId: req.auth!.user.id,
        actorType: req.auth!.user.role === 'ADMIN' ? 'ADMIN' : 'USER',
        action: 'REPORT_EXPORTED',
        resourceType: 'payment_order',
        resourceId: merchant?.id ?? null,
        metadata: { rows: rows.length, scope: merchant ? 'merchant' : 'all' },
        ipHash: clientIpHash(req),
      });
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="orders-${new Date().toISOString().slice(0, 10)}.csv"`);
      res.setHeader('Cache-Control', 'no-store');
      res.send(`\uFEFF${csv}`);
    }),
  );

  return router;
}

function absoluteUrl(req: import('express').Request, path: string): string {
  const host = req.get('host');
  if (host) return `${req.protocol}://${host}${path}`;
  return `${getConfig().appUrl}${path}`;
}

function parseStatusFilter(value: unknown): OrderStatus[] | undefined {
  const raw = Array.isArray(value) ? value : typeof value === 'string' ? [value] : [];
  const valid = raw.filter((v): v is OrderStatus => ORDER_STATUSES.includes(v as OrderStatus));
  return valid.length > 0 ? valid : undefined;
}

function parseDate(value: unknown): Date | undefined {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return undefined;
  const d = new Date(`${value}T00:00:00+05:30`);
  return Number.isNaN(d.getTime()) ? undefined : d;
}

/** Prevents CSV formula injection and quotes every field. */
function csvCell(value: unknown): string {
  const raw = value === null || value === undefined ? '' : String(value);
  const safe = /^[=+\-@]/.test(raw) ? `'${raw}` : raw;
  return `"${safe.replace(/"/g, '""')}"`;
}
