import express, { Router } from 'express';
import { AppError, ProviderError, isAppError } from '../../errors';
import { getLogger } from '../../observability/logger';
import { asyncHandler, clientIpHash } from '../middleware';
import { ingestProviderWebhook } from '../../services/payments';
import { assertProviderAllowed, tryGetProvider } from '../../providers/registry';
import { getConfig } from '../../config';

/**
 * Provider webhook endpoints.
 *
 * Security contract:
 *  - the raw body is captured before any parser and verified against the
 *    provider's signature scheme
 *  - duplicate events are acknowledged with 200 so the provider stops retrying
 *  - transient failures return 5xx so the provider retries later
 *  - nothing here trusts a "status" field from a browser
 */
export function webhookRouter(): Router {
  const router = Router();

  router.post(
    '/:provider',
    express.raw({ type: '*/*', limit: '256kb' }),
    asyncHandler(async (req, res) => {
      const providerName = String(req.params.provider ?? '');
      const provider = tryGetProvider(providerName);
      if (!provider) {
        res.status(404).json({ error: 'Unknown provider' });
        return;
      }
      try {
        assertProviderAllowed(providerName);
      } catch {
        res.status(404).json({ error: 'Provider is not enabled' });
        return;
      }
      if (!provider.isConfigured()) {
        res.status(503).json({ error: 'Provider is not configured' });
        return;
      }
      if (!Buffer.isBuffer(req.body) || req.body.length === 0) {
        throw new AppError('WEBHOOK_MALFORMED', 'Empty webhook body', 400);
      }

      const result = await ingestProviderWebhook({
        providerName,
        rawBody: req.body,
        headers: req.headers as Record<string, string | string[] | undefined>,
        ipHash: clientIpHash(req),
      });

      res.setHeader('Cache-Control', 'no-store');
      res.status(result.httpStatus).json({
        received: true,
        outcome: result.outcome,
        duplicate: result.outcome === 'DUPLICATE',
      });
    }),
  );

  // Some providers verify the endpoint with a GET probe.
  router.get('/:provider', (req, res) => {
    const provider = tryGetProvider(String(req.params.provider ?? ''));
    res.json({
      provider: req.params.provider,
      configured: provider?.isConfigured() ?? false,
      mode: getConfig().nodeEnv,
    });
  });

  return router;
}

export { isAppError, ProviderError, getLogger };
