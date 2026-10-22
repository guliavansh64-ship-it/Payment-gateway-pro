import { Router } from 'express';
import { z } from 'zod';
import { AppError } from '../../errors';
import { getConfig } from '../../config';
import { isValidVpa } from '../../domain/upi';
import * as accounts from '../../repos/accounts';
import * as merchantRepo from '../../repos/merchants';
import * as ops from '../../repos/ops';
import { getProvider, providerPublicInfo, tryGetProvider } from '../../providers/registry';
import { asyncHandler, clientIpHash, requireAuth, requireStepUp } from '../middleware';
import { requireCsrf } from '../session';
import { checkProviderHealth } from '../../workers/jobs';
import { reconcileRefund } from '../../services/refunds';

/** Administrator controls. Every mutation is step-up protected and audited. */
export function adminRouter(): Router {
  const router = Router();
  router.use(requireAuth(['ADMIN']));

  router.get(
    '/',
    asyncHandler(async (req, res) => {
      const [merchants, cases, runs, configs, stats] = await Promise.all([
        orderRepoSummaries(),
        ops.listReconciliationCases({ status: 'OPEN', limit: 10 }),
        ops.listRecentRuns(10),
        ops.listProviderConfigs(),
        (await import('../../repos/orders')).globalStats(),
      ]);
      res.render('admin/home', {
        title: 'Administration',
        merchants,
        cases: cases.rows,
        caseTotal: cases.total,
        runs,
        providers: providerPublicInfo(),
        configs,
        stats,
      });
    }),
  );

  router.get(
    '/providers',
    asyncHandler(async (req, res) => {
      const [configs, health] = await Promise.all([ops.listProviderConfigs(), Promise.resolve(providerPublicInfo())]);
      res.render('admin/providers', {
        title: 'Provider configuration',
        providers: health,
        configs,
        config: getConfig(),
      });
    }),
  );

  const providerSchema = z.object({
    provider_name: z.string().min(2).max(40),
    enabled: z.union([z.literal('on'), z.literal('true'), z.literal('false'), z.undefined()]),
    mode: z.enum(['test', 'live', 'sandbox', 'production']),
  });

  router.post(
    '/providers',
    requireStepUp(),
    requireCsrf,
    asyncHandler(async (req, res) => {
      const parsed = providerSchema.safeParse(req.body);
      if (!parsed.success) return res.redirect('/admin/providers?error=invalid-input');
      const provider = tryGetProvider(parsed.data.provider_name);
      if (!provider) throw new AppError('NOT_FOUND', 'Unknown provider', 404);
      if (provider.capabilities.simulated && getConfig().isProduction) {
        throw new AppError('FORBIDDEN', 'The sandbox provider cannot be enabled in production', 403);
      }
      const enabled = parsed.data.enabled === 'on' || parsed.data.enabled === 'true';
      if (enabled && !provider.isConfigured()) {
        throw new AppError(
          'PROVIDER_NOT_CONFIGURED',
          'Credentials are missing for this provider. Set them in the environment before enabling it.',
          409,
        );
      }
      await ops.upsertProviderConfig({
        providerName: provider.name,
        enabled,
        mode: parsed.data.mode,
        updatedBy: req.auth!.user.id,
      });
      await ops.writeAudit({
        actorId: req.auth!.user.id,
        actorType: 'ADMIN',
        action: enabled ? 'PROVIDER_ENABLED' : 'PROVIDER_DISABLED',
        resourceType: 'provider_config',
        resourceId: provider.name,
        metadata: { mode: parsed.data.mode },
        ipHash: clientIpHash(req),
      });
      res.redirect('/admin/providers?notice=provider-updated');
    }),
  );

  router.post(
    '/providers/health',
    requireCsrf,
    asyncHandler(async (req, res) => {
      await checkProviderHealth();
      res.redirect('/admin/providers?notice=health-checked');
    }),
  );

  router.get(
    '/merchants',
    asyncHandler(async (req, res) => {
      const merchants = await orderRepoSummaries();
      const users = await accounts.listUsers(200);
      res.render('admin/merchants', {
        title: 'Merchants',
        merchants,
        users,
      });
    }),
  );

  router.post(
    '/merchants/:merchantId/upi',
    requireStepUp(),
    requireCsrf,
    asyncHandler(async (req, res) => {
      const merchantId = String(req.params.merchantId);
      const merchant = await merchantRepo.findMerchantById(merchantId);
      if (!merchant) throw new AppError('NOT_FOUND', 'Merchant not found', 404);
      const raw = String(req.body.upi_id ?? '').trim().toLowerCase();
      if (raw.length === 0) {
        await merchantRepo.setVerifiedUpiId({ merchantId, upiId: null, verifiedBy: req.auth!.user.id });
        await ops.writeAudit({
          actorId: req.auth!.user.id,
          actorType: 'ADMIN',
          action: 'MERCHANT_UPI_CLEARED',
          resourceType: 'merchant',
          resourceId: merchantId,
          ipHash: clientIpHash(req),
        });
        return res.redirect('/admin/merchants?notice=upi-cleared');
      }
      if (!isValidVpa(raw)) return res.redirect('/admin/merchants?error=invalid-input');
      await merchantRepo.setVerifiedUpiId({ merchantId, upiId: raw, verifiedBy: req.auth!.user.id });
      await ops.writeAudit({
        actorId: req.auth!.user.id,
        actorType: 'ADMIN',
        action: 'MERCHANT_UPI_VERIFIED',
        resourceType: 'merchant',
        resourceId: merchantId,
        metadata: { vpa_masked: `${raw.slice(0, 2)}***@${raw.split('@')[1] ?? ''}` },
        ipHash: clientIpHash(req),
      });
      res.redirect('/admin/merchants?notice=upi-verified');
    }),
  );

  const statusSchema = z.object({
    status: z.enum(['PENDING', 'ACTIVE', 'SUSPENDED', 'CLOSED']),
    policy: z.enum(['FULFIL', 'REFUND', 'REVIEW']).optional(),
  });

  router.post(
    '/merchants/:merchantId/status',
    requireCsrf,
    asyncHandler(async (req, res) => {
      const merchantId = String(req.params.merchantId);
      const parsed = statusSchema.safeParse(req.body);
      if (!parsed.success) return res.redirect('/admin/merchants?error=invalid-input');
      if (parsed.data.status === 'ACTIVE') {
        const merchant = await merchantRepo.findMerchantById(merchantId);
        if (!merchant) throw new AppError('NOT_FOUND', 'Merchant not found', 404);
        if (!merchant.verifiedMerchantUpiId && !merchant.defaultProvider) {
          throw new AppError(
            'VALIDATION_ERROR',
            'Activate only after verifying a UPI ID or configuring a provider for this merchant',
            409,
          );
        }
      }
      await merchantRepo.setAccountStatus(merchantId, parsed.data.status);
      if (parsed.data.policy) await merchantRepo.setLatePaymentPolicy(merchantId, parsed.data.policy);
      await ops.writeAudit({
        actorId: req.auth!.user.id,
        actorType: 'ADMIN',
        action: 'MERCHANT_STATUS_CHANGED',
        resourceType: 'merchant',
        resourceId: merchantId,
        metadata: { status: parsed.data.status, late_payment_policy: parsed.data.policy ?? null },
        ipHash: clientIpHash(req),
      });
      res.redirect('/admin/merchants?notice=merchant-updated');
    }),
  );

  router.get(
    '/reconciliation',
    asyncHandler(async (req, res) => {
      const [cases, runs] = await Promise.all([
        ops.listReconciliationCases({ status: 'OPEN', limit: 100 }),
        ops.listRecentRuns(20),
      ]);
      res.render('dashboard/reconciliation', {
        title: 'Reconciliation queue',
        merchant: null,
        cases: cases.rows,
        total: cases.total,
        runs,
        refunds: [],
      });
    }),
  );

  router.get(
    '/audit',
    asyncHandler(async (req, res) => {
      const [result, securityEvents] = await Promise.all([
        ops.listAuditLogs({
          action: typeof req.query.action === 'string' ? req.query.action : undefined,
          limit: 150,
        }),
        ops.listAuditLogs({ action: 'LOGIN_FAILED', limit: 20 }),
      ]);
      res.render('dashboard/audit', {
        title: 'Audit log',
        merchant: null,
        rows: result.rows,
        total: result.total,
        actionFilter: typeof req.query.action === 'string' ? req.query.action : '',
        securityEvents: securityEvents.rows,
      });
    }),
  );

  router.get(
    '/users',
    asyncHandler(async (req, res) => {
      const users = await accounts.listUsers(200);
      res.render('admin/users', { title: 'Users', users });
    }),
  );

  router.get(
    '/security',
    asyncHandler(async (req, res) => {
      const [logins, rateLimits, providerConfigs, securityAudit] = await Promise.all([
        ops.listAuditLogs({ action: 'LOGIN_FAILED', limit: 25 }),
        ops.listRateLimits(50),
        ops.listProviderConfigs(),
        ops.listAuditLogs({ resourceType: 'session', limit: 25 }),
      ]);
      res.render('admin/security', {
        title: 'Security',
        failedLogins: logins.rows,
        rateLimits,
        providerConfigs,
        sessionEvents: securityAudit.rows,
        config: getConfig(),
      });
    }),
  );

  router.post(
    '/refunds/:refundId/reconcile',
    requireCsrf,
    asyncHandler(async (req, res) => {
      await reconcileRefund({
        refundId: String(req.params.refundId),
        adminId: req.auth!.user.id,
        ipHash: clientIpHash(req),
      });
      res.redirect(`${String(req.body.return_to ?? '/admin/reconciliation')}?notice=refund-reconciled`);
    }),
  );

  return router;
}

async function orderRepoSummaries() {
  const { merchantSummaries } = await import('../../repos/orders');
  return merchantSummaries();
}

export { getProvider };
