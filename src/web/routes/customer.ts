import { randomBytes, randomInt } from 'node:crypto';
import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import { getConfig } from '../../config';
import { AppError } from '../../errors';
import { formatPaise } from '../../domain/money';
import { normalizeOrderId } from '../../domain/ids';
import type { Order, PaymentMethod } from '../../domain/models';
import { createOrder, getOrderForCustomer } from '../../services/orders';
import { ingestProviderWebhook, verifyOrderWithProvider } from '../../services/payments';
import { isProviderEnabledInDb } from '../../repos/ops';
import { listMerchants } from '../../repos/merchants';
import { SandboxProvider } from '../../providers/sandbox';
import { tryGetProvider } from '../../providers/registry';
import { safeCompare } from '../../security/crypto';
import { asyncHandler, clientIpHash } from '../middleware';
import { qrResponse } from '../qr';
import { formatDate, statusLabel, statusTone } from '../helpers';

const statusLimiter = rateLimit({ windowMs: 60_000, limit: 30, standardHeaders: 'draft-7', legacyHeaders: false });
const checkLimiter = rateLimit({ windowMs: 60_000, limit: 10, standardHeaders: 'draft-7', legacyHeaders: false });
const createLimiter = rateLimit({ windowMs: 60_000, limit: 12, standardHeaders: 'draft-7', legacyHeaders: false });

const createSchema = z.object({
  merchant_id: z.string().uuid().optional(),
  amount: z.string().regex(/^\d{1,9}(\.\d{1,2})?$/, 'Enter an amount like 499.00'),
  description: z.string().max(200).optional(),
});

function requireToken(order: Order, token: unknown): void {
  const provided = typeof token === 'string' ? token : '';
  if (!provided || !safeCompare(order.publicToken, provided)) {
    throw new AppError('NOT_FOUND', 'Payment link is invalid or has expired', 404);
  }
}

function publicStatusPayload(order: Order) {
  return {
    orderId: order.orderId,
    status: order.status,
    label: statusLabel(order.status),
    tone: statusTone(order.status),
    amountPaise: order.amountPaise,
    amount: formatPaise(order.amountPaise),
    paidAt: order.paidAt?.toISOString() ?? null,
    expiresAt: order.expiresAt.toISOString(),
    updatedAt: order.updatedAt.toISOString(),
    verificationSource: order.verificationSource,
    canCheck: ['CREATED', 'PENDING', 'VERIFYING', 'EXPIRED'].includes(order.status),
  };
}

export function customerRouter(): Router {
  const router = Router();

  // -------------------------------------------------------------------------
  // Public landing / demo payment request form
  // -------------------------------------------------------------------------
  router.get(
    '/',
    asyncHandler(async (req, res) => {
      const config = getConfig();
      const sandboxEnabled = config.allowSandboxProvider && !config.isProduction;
      const merchants = sandboxEnabled ? (await listMerchants()).filter((m) => m.accountStatus === 'ACTIVE') : [];
      res.render('home', {
        title: 'Collect UPI payments with verified settlement',
        sandboxEnabled,
        merchants: merchants.map((m) => ({
          id: m.id,
          businessName: m.businessName,
          upi: m.verifiedMerchantUpiId,
        })),
        providers: sanitizeProviderList(),
        defaultExpiryMinutes: config.defaultOrderExpiryMinutes,
        demoError: typeof req.query.error === 'string' ? req.query.error : null,
      });
    }),
  );

  router.post(
    '/pay/new',
    createLimiter,
    asyncHandler(async (req, res) => {
      const config = getConfig();
      if (!config.allowSandboxProvider || config.isProduction) {
        // Public order creation is a demo affordance only. Real merchants create
        // payment requests from their dashboard or the authenticated API.
        throw new AppError('FORBIDDEN', 'Public payment requests are disabled', 403);
      }
      const parsed = createSchema.safeParse(req.body);
      if (!parsed.success) return res.redirect('/?error=Enter+a+valid+amount+like+499.00');

      const merchants = (await listMerchants()).filter((m) => m.accountStatus === 'ACTIVE');
      const merchant = parsed.data.merchant_id
        ? merchants.find((m) => m.id === parsed.data.merchant_id)
        : merchants[0];
      if (!merchant) return res.redirect('/?error=No+active+merchant');

      const sandboxConfigured = (await isProviderEnabledInDb('sandbox')) && tryGetProvider('sandbox')?.isConfigured();
      const paymentMethod: PaymentMethod = 'UPI_QR';
      const { order } = await createOrder(
        {
          merchantId: merchant.id,
          amountRupees: parsed.data.amount,
          paymentMethod,
          description: parsed.data.description || 'Demo order',
          customerReference: null,
          providerName: sandboxConfigured ? 'sandbox' : undefined,
        },
        { actorId: null, actorType: 'SYSTEM', ipHash: clientIpHash(req) },
      );
      res.redirect(`/pay/${order.orderId}?t=${encodeURIComponent(order.publicToken)}`);
    }),
  );

  // -------------------------------------------------------------------------
  // Payment page
  // -------------------------------------------------------------------------
  router.get(
    '/pay/:orderId',
    asyncHandler(async (req, res) => {
      const orderId = normalizeOrderId(req.params.orderId ?? '');
      if (!orderId) throw new AppError('NOT_FOUND', 'Payment request not found', 404);
      const result = await getOrderForCustomer(orderId);
      if (!result) throw new AppError('NOT_FOUND', 'Payment request not found', 404);
      requireToken(result.order, req.query.t);

      const order = result.order;
      const qr = await qrForOrder(order);
      const instructions = instructionsFor(order);

      res.render('pay', {
        title: `Pay ₹${formatPaise(order.amountPaise)} · ${result.merchant.businessName}`,
        order,
        merchant: result.merchant,
        token: order.publicToken,
        qr,
        instructions,
        expired: order.expiresAt.getTime() < Date.now(),
        expiryLabel: formatDate(order.expiresAt),
        sandbox: order.providerName === 'sandbox',
        notice: typeof req.query.notice === 'string' ? req.query.notice : null,
      });
    }),
  );

  router.get(
    '/pay/:orderId/qr.png',
    asyncHandler(async (req, res) => {
      const orderId = normalizeOrderId(req.params.orderId ?? '');
      const result = orderId ? await getOrderForCustomer(orderId) : null;
      if (!result) throw new AppError('NOT_FOUND', 'Payment request not found', 404);
      requireToken(result.order, req.query.t);
      const qr = await qrForOrder(result.order);
      if (!qr.payload) throw new AppError('NOT_FOUND', 'No QR payload for this order', 404);

      const image = await qrResponse(qr.payload);
      res.setHeader('Content-Type', image.contentType);
      res.setHeader('Cache-Control', 'no-store');
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.send(image.body);
    }),
  );

  router.get(
    '/pay/:orderId/status',
    statusLimiter,
    asyncHandler(async (req, res) => {
      const orderId = normalizeOrderId(req.params.orderId ?? '');
      const result = orderId ? await getOrderForCustomer(orderId) : null;
      if (!result) throw new AppError('NOT_FOUND', 'Payment request not found', 404);
      requireToken(result.order, req.query.t);
      res.setHeader('Cache-Control', 'no-store');
      res.json(publicStatusPayload(result.order));
    }),
  );

  /**
   * Customer-initiated status check. This is a *read* that asks the provider for
   * the authoritative state; it can never mark an order paid by itself.
   */
  router.get(
    '/pay/:orderId/check',
    checkLimiter,
    asyncHandler(async (req, res) => {
      const orderId = normalizeOrderId(req.params.orderId ?? '');
      const result = orderId ? await getOrderForCustomer(orderId) : null;
      if (!result) throw new AppError('NOT_FOUND', 'Payment request not found', 404);
      requireToken(result.order, req.query.t);

      if (result.order.providerName !== 'manual_upi' && result.order.providerPaymentId) {
        await verifyOrderWithProvider(result.order, {
          trigger: 'CUSTOMER_CHECK',
          ipHash: clientIpHash(req),
        });
      }
      const refreshed = await getOrderForCustomer(result.order.orderId);
      res.setHeader('Cache-Control', 'no-store');
      res.json(publicStatusPayload(refreshed?.order ?? result.order));
    }),
  );

  // Legacy form post used by older links; same semantics as the GET check.
  router.post(
    '/pay/:orderId/check',
    checkLimiter,
    asyncHandler(async (req, res) => {
      const orderId = normalizeOrderId(req.params.orderId ?? '');
      const result = orderId ? await getOrderForCustomer(orderId) : null;
      if (!result) throw new AppError('NOT_FOUND', 'Payment request not found', 404);
      requireToken(result.order, req.body?.t);
      if (result.order.providerName !== 'manual_upi' && result.order.providerPaymentId) {
        await verifyOrderWithProvider(result.order, { trigger: 'CUSTOMER_CHECK', ipHash: clientIpHash(req) });
      }
      res.redirect(
        `/pay/${result.order.orderId}?t=${encodeURIComponent(result.order.publicToken)}&notice=checked`,
      );
    }),
  );

  router.get('/pay-return', (req, res) => {
    res.render('pay-return', {
      title: 'Confirming your payment',
      orderId: typeof req.query.order === 'string' ? req.query.order : null,
    });
  });

  // -------------------------------------------------------------------------
  // Sandbox simulator (test double; 404 unless explicitly enabled)
  // -------------------------------------------------------------------------
  router.get(
    '/sandbox/pay/:orderId',
    asyncHandler(async (req, res) => {
      assertSandboxEnabled();
      const orderId = normalizeOrderId(req.params.orderId ?? '');
      const found = orderId ? await getOrderForCustomer(orderId) : null;
      if (!found) throw new AppError('NOT_FOUND', 'Payment request not found', 404);
      requireToken(found.order, req.query.t);
      res.render('sandbox-pay', {
        title: 'Sandbox payment simulator',
        order: found.order,
        merchant: found.merchant,
        token: found.order.publicToken,
      });
    }),
  );

  router.post(
    '/sandbox/simulate',
    createLimiter,
    asyncHandler(async (req, res) => {
      assertSandboxEnabled();
      const orderId = normalizeOrderId(String(req.body.order_id ?? ''));
      const found = orderId ? await getOrderForCustomer(orderId) : null;
      if (!found) throw new AppError('NOT_FOUND', 'Payment request not found', 404);
      requireToken(found.order, req.body.t);

      const scenario = String(req.body.scenario ?? 'success');
      const amountPaise =
        scenario === 'underpay'
          ? Math.max(100, found.order.amountPaise - 100)
          : scenario === 'overpay'
            ? found.order.amountPaise + 5000
            : found.order.amountPaise;
      const status = scenario === 'failure' ? 'FAILED' : scenario === 'pending' ? 'PENDING' : 'SUCCESS';
      const reference = `SBX${randomInt(100000000, 999999999)}`;
      const providerPaymentId = found.order.providerPaymentId ?? `sbx_${orderId.replace(/[^A-Za-z0-9]/g, '')}`;

      const event = {
        event_id: `sbx_${randomBytes(12).toString('hex')}`,
        event_type: status === 'SUCCESS' ? 'payment.success' : status === 'FAILED' ? 'payment.failed' : 'payment.pending',
        provider_payment_id: providerPaymentId,
        order_reference: orderId,
        amount_paise: amountPaise,
        currency: 'INR',
        status,
        paid_at: status === 'SUCCESS' ? new Date().toISOString() : null,
        provider_transaction_reference: reference,
        payee_vpa: found.order.upiPayeeVpa ?? 'sandbox.merchant@upi',
        failure_reason: status === 'FAILED' ? 'Simulated failure (sandbox)' : null,
      };

      // Record the simulated provider-side payment so status polling can find it.
      await SandboxProvider.recordSimulatedPayment({
        providerPaymentId,
        orderReference: orderId,
        status,
        amountPaise,
        providerTransactionReference: reference,
        payeeVpa: found.order.upiPayeeVpa ?? 'sandbox.merchant@upi',
      });

      // Then deliver it exactly like a real provider: signed raw body through the
      // webhook ingestion path. The simulator has no privileged shortcut.
      const signed = SandboxProvider.buildSignedEvent(event);
      await ingestProviderWebhook({
        providerName: 'sandbox',
        rawBody: Buffer.from(signed.body),
        headers: { 'x-sandbox-signature': signed.signature, 'content-type': 'application/json' },
        ipHash: clientIpHash(req),
      });

      res.redirect(`/pay/${orderId}?t=${encodeURIComponent(found.order.publicToken)}&notice=simulated`);
    }),
  );

  return router;
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function assertSandboxEnabled(): void {
  const config = getConfig();
  if (!config.allowSandboxProvider || config.isProduction) {
    throw new AppError('NOT_FOUND', 'Sandbox is not available', 404);
  }
  const sandbox = tryGetProvider('sandbox');
  if (!sandbox || !sandbox.isConfigured()) {
    throw new AppError('NOT_FOUND', 'Sandbox is not available', 404);
  }
}

async function qrForOrder(order: Order): Promise<{ payload: string | null; label: string }> {
  if (order.qrPayload) return { payload: order.qrPayload, label: 'Static UPI QR' };
  if (order.upiPayeeVpa) {
    const { buildUpiUri } = await import('../../domain/upi');
    return {
      payload: buildUpiUri({
        payeeVpa: order.upiPayeeVpa,
        payeeName: order.upiPayeeName ?? 'Merchant',
        amountPaise: order.amountPaise,
        transactionRef: order.orderId,
        transactionNote: `Order ${order.orderId}`,
      }),
      label: 'Dynamic UPI QR',
    };
  }
  return { payload: null, label: 'No QR' };
}

function instructionsFor(order: Order): string[] {
  const common = ['This page never asks for a UPI PIN, OTP, bank password or card details.'];
  if (order.providerName === 'manual_upi') {
    return [
      `Open any UPI app and pay ₹${formatPaise(order.amountPaise)} to ${order.upiPayeeVpa ?? 'the merchant UPI ID'}.`,
      `If your app allows a note, enter ${order.orderId}. Many UPI apps do not send it to the merchant.`,
      'Keep the UPI reference number (UTR) from your payment app. The merchant may ask for it.',
      'The merchant confirms your payment against the bank or provider record before marking it paid.',
      ...common,
    ];
  }
  return [
    `Scan the QR code or tap “Open in UPI app” and pay ₹${formatPaise(order.amountPaise)}.`,
    `Check the payee name (${order.upiPayeeName ?? 'merchant'}) before confirming.`,
    'Complete the payment inside your own UPI app using your UPI PIN.',
    'Come back to this page and tap “Check payment status”.',
    'Confirmation comes from the payment provider, never from this browser.',
    ...common,
  ];
}

function sanitizeProviderList() {
  return ['razorpay', 'cashfree', 'manual_upi', 'sandbox']
    .map((name) => tryGetProvider(name))
    .filter((p): p is NonNullable<typeof p> => Boolean(p))
    .map((p) => ({
      name: p.name,
      displayName: p.displayName,
      configured: p.isConfigured(),
      simulated: p.capabilities.simulated ?? false,
    }));
}
