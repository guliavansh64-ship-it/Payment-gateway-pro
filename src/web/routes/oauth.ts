import { Router } from 'express';
import { getConfig } from '../../config';
import { AppError } from '../../errors';
import { findMerchantByOwner } from '../../repos/merchants';
import { writeAudit } from '../../repos/ops';
import { createPkcePair, createState, exchangeAuthorizationCode, fetchUserEmail, isGoogleConfigured } from '../../gmail/oauth';
import { encryptRefreshToken } from '../../gmail/service';
import { upsertGmailConnection } from '../../repos/ops';
import { signState, verifyState } from '../../security/signed-state';
import { asyncHandler, clientIpHash, requireAuth } from '../middleware';
import { OAUTH_COOKIE, sessionCookieOptions } from '../session';

/**
 * Gmail OAuth routes.
 *
 * The state parameter is HMAC-signed and carries the PKCE verifier, the user it
 * was issued to, and an expiry. The callback requires the signed cookie, a
 * matching state, and the same signed-in user.
 */
export function oauthRouter(): Router {
  const router = Router();

  router.get(
    '/oauth/google/start',
    requireAuth(['MERCHANT_ADMIN', 'ADMIN']),
    asyncHandler(async (req, res) => {
      if (!isGoogleConfigured()) {
        throw new AppError('PROVIDER_NOT_CONFIGURED', 'Google OAuth is not configured on this deployment', 503);
      }
      const { verifier, challenge } = createPkcePair();
      const state = createState();
      const merchant = await findMerchantByOwner(req.auth!.user.id);
      const payload = signState({
        state,
        codeVerifier: verifier,
        userId: req.auth!.user.id,
        redirectTo: '/dashboard/gmail',
        exp: Date.now() + 10 * 60_000,
      });
      res.cookie(OAUTH_COOKIE, payload, {
        ...sessionCookieOptions(),
        maxAge: 10 * 60_000,
      });
      const { buildAuthUrl } = await import('../../gmail/oauth');
      const url = buildAuthUrl({ state, codeChallenge: challenge });
      await writeAudit({
        actorId: req.auth!.user.id,
        actorType: 'USER',
        action: 'GMAIL_OAUTH_STARTED',
        resourceType: 'gmail_connection',
        resourceId: null,
        metadata: { merchant_id: merchant?.id ?? null },
        ipHash: clientIpHash(req),
      });
      res.redirect(url);
    }),
  );

  router.get(
    '/oauth/google/callback',
    requireAuth(['MERCHANT_ADMIN', 'ADMIN']),
    asyncHandler(async (req, res) => {
      const cookieValue = req.cookies?.[OAUTH_COOKIE];
      res.clearCookie(OAUTH_COOKIE, { path: '/' });
      if (typeof cookieValue !== 'string') {
        throw new AppError('FORBIDDEN', 'OAuth state cookie missing or expired', 403);
      }
      const payload = verifyState(cookieValue);
      if (!payload) throw new AppError('FORBIDDEN', 'OAuth state is invalid or expired', 403);
      if (payload.userId !== req.auth!.user.id) {
        throw new AppError('FORBIDDEN', 'OAuth state belongs to a different user', 403);
      }
      const state = typeof req.query.state === 'string' ? req.query.state : '';
      if (state !== payload.state) throw new AppError('FORBIDDEN', 'OAuth state mismatch', 403);
      if (typeof req.query.error === 'string') {
        return res.redirect('/dashboard/gmail?error=oauth-denied');
      }
      const code = typeof req.query.code === 'string' ? req.query.code : '';
      if (!code) throw new AppError('VALIDATION_ERROR', 'Authorization code missing', 400);

      const tokens = await exchangeAuthorizationCode({
        code,
        codeVerifier: payload.codeVerifier,
      });
      if (!tokens.refreshToken) {
        return res.redirect('/dashboard/gmail?error=no-refresh-token');
      }
      const email = await fetchUserEmail(tokens.accessToken);
      const merchant = await findMerchantByOwner(req.auth!.user.id);
      const connection = await upsertGmailConnection({
        userId: req.auth!.user.id,
        merchantId: merchant?.id ?? null,
        providerEmail: email,
        encryptedRefreshToken: encryptRefreshToken(req.auth!.user.id, tokens.refreshToken),
        tokenKeyVersion: getConfig().encryptionKeys[0]?.version ?? 'v1',
        grantedScopes: tokens.scope.split(/\s+/).filter(Boolean),
      });
      await writeAudit({
        actorId: req.auth!.user.id,
        actorType: 'USER',
        action: 'GMAIL_CONNECTED',
        resourceType: 'gmail_connection',
        resourceId: connection.id,
        metadata: { provider_email_domain: email.split('@')[1] ?? null },
        ipHash: clientIpHash(req),
      });
      res.redirect('/dashboard/gmail?notice=gmail-connected');
    }),
  );

  return router;
}
