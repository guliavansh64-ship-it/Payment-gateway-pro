import { Router } from 'express';
import { randomBytes } from 'node:crypto';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import { AppError } from '../../errors';
import {
  createSession,
  elevateSession,
  findUserByEmail,
  registerLoginFailure,
  registerLoginSuccess,
  revokeSession,
} from '../../repos/accounts';
import { writeAudit } from '../../repos/ops';
import { consumeLimit, resetLimit } from '../../security/rate-limit';
import { verifyPassword } from '../../security/crypto';
import { asyncHandler, clientIpHash, requireAuth } from '../middleware';
import {
  CSRF_COOKIE,
  SESSION_COOKIE,
  csrfCookieOptions,
  destroySession,
  hashToken,
  newCsrfToken,
  newSessionToken,
  requireCsrf,
  sessionCookieOptions,
  sessionExpiry,
} from '../session';

const loginSchema = z.object({
  email: z.string().trim().min(3).max(254),
  password: z.string().min(1).max(256),
  next: z.string().max(500).optional(),
});

/** Only same-site, path-relative redirects are honoured (no open redirect). */
export function safeNext(value: unknown): string {
  if (typeof value !== 'string') return '/dashboard';
  if (!value.startsWith('/') || value.startsWith('//') || value.includes('\\')) return '/dashboard';
  return value;
}

const PREAUTH_COOKIE = 'preauth';

const loginLimiter = rateLimit({
  windowMs: 15 * 60_000,
  limit: 20,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: 'Too many sign-in attempts from this address. Try again later.',
});

export function authRouter(): Router {
  const router = Router();

  router.get('/login', (req, res) => {
    if (req.auth) return res.redirect(safeNext(req.query.next));
    // Pre-authentication CSRF token: prevents login CSRF (forcing a victim into
    // an attacker's session) without needing a session store entry.
    const preauth = randomBytes(24).toString('base64url');
    res.cookie(PREAUTH_COOKIE, preauth, {
      ...csrfCookieOptions(),
      signed: true,
      maxAge: 15 * 60_000,
    });
    res.render('login', {
      title: 'Sign in',
      next: typeof req.query.next === 'string' ? req.query.next : '/dashboard',
      error: typeof req.query.error === 'string' ? 'Email or password is incorrect.' : null,
      email: '',
      preauthToken: preauth,
    });
  });

  router.post(
    '/login',
    loginLimiter,
    asyncHandler(async (req, res) => {
      const preauthCookie = req.signedCookies?.[PREAUTH_COOKIE];
      const submitted = typeof req.body?._csrf === 'string' ? req.body._csrf : '';
      if (
        typeof preauthCookie !== 'string' ||
        submitted.length === 0 ||
        submitted.length !== preauthCookie.length ||
        submitted !== preauthCookie
      ) {
        return res.status(403).render('login', {
          title: 'Sign in',
          next: '/dashboard',
          error: 'Your sign-in page expired. Reload and try again.',
          email: typeof req.body?.email === 'string' ? req.body.email.slice(0, 120) : '',
          preauthToken: '',
        });
      }
      const parsed = loginSchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).render('login', {
          title: 'Sign in',
          next: '/dashboard',
          error: 'Enter your email and password.',
          email: '',
          preauthToken: preauthCookie ?? '',
        });
      }
      const { email, password } = parsed.data;
      const next = safeNext(parsed.data.next);
      const ipHash = clientIpHash(req);
      const emailHash = hashToken(email.toLowerCase());

      // Persistent limiter: works across instances and survives restarts.
      const emailLimit = await consumeLimit('login-email', emailHash, 10, 900);
      if (!emailLimit.allowed) {
        await writeAudit({
          actorId: null,
          actorType: 'USER',
          action: 'LOGIN_RATE_LIMITED',
          resourceType: 'user',
          resourceId: null,
          metadata: { email_hash: emailHash.slice(0, 12) },
          ipHash,
        });
        return res.status(429).render('login', {
          title: 'Sign in',
          next,
          error: 'Too many attempts for this account. Try again in a few minutes.',
          email,
          preauthToken: preauthCookie ?? '',
        });
      }

      const found = await findUserByEmail(email);
      const passwordOk = await verifyPassword(password, found?.passwordHash ?? null);
      const locked = found?.user.lockedUntil && found.user.lockedUntil.getTime() > Date.now();

      if (!found || !passwordOk || !found.user.isActive || locked) {
        if (found) await registerLoginFailure(found.user.id, 8, 15);
        await writeAudit({
          actorId: found?.user.id ?? null,
          actorType: 'USER',
          action: 'LOGIN_FAILED',
          resourceType: 'user',
          resourceId: found?.user.id ?? null,
          metadata: { locked: Boolean(locked), user_exists: Boolean(found) },
          ipHash,
        });
        return res.status(401).render('login', {
          title: 'Sign in',
          next,
          error: locked ? 'This account is temporarily locked. Try again later.' : 'Email or password is incorrect.',
          email,
          preauthToken: preauthCookie ?? '',
        });
      }

      await registerLoginSuccess(found.user.id);
      await resetLimit('login-email', emailHash);

      const token = newSessionToken();
      const csrf = newCsrfToken();
      await createSession({
        userId: found.user.id,
        tokenHash: hashToken(token),
        csrfTokenHash: hashToken(csrf),
        ipHash,
        userAgentHash: hashToken(req.get('user-agent') ?? 'unknown').slice(0, 32),
        expiresAt: sessionExpiry(),
      });
      await writeAudit({
        actorId: found.user.id,
        actorType: 'USER',
        action: 'LOGIN_SUCCESS',
        resourceType: 'user',
        resourceId: found.user.id,
        metadata: { role: found.user.role },
        ipHash,
      });

      res.clearCookie(PREAUTH_COOKIE, { path: '/' });
      res.cookie(SESSION_COOKIE, token, sessionCookieOptions());
      res.cookie(CSRF_COOKIE, csrf, csrfCookieOptions());
      res.redirect(next);
    }),
  );

  router.post(
    '/logout',
    requireAuth(),
    requireCsrf,
    asyncHandler(async (req, res) => {
      if (req.auth) {
        await revokeSession(req.auth.session.id);
        await writeAudit({
          actorId: req.auth.user.id,
          actorType: 'USER',
          action: 'LOGOUT',
          resourceType: 'session',
          resourceId: req.auth.session.id,
          ipHash: clientIpHash(req),
        });
      }
      await destroySession(req, res);
      res.redirect('/login?notice=signed-out');
    }),
  );

  router.get('/step-up', requireAuth(), (req, res) => {
    res.render('step-up', {
      title: 'Confirm password',
      next: safeNext(req.query.next),
      error: null,
    });
  });

  router.post(
    '/step-up',
    requireAuth(),
    requireCsrf,
    asyncHandler(async (req, res) => {
      const next = safeNext(req.body.next);
      const password = typeof req.body.password === 'string' ? req.body.password : '';
      const found = await findUserByEmail(req.auth!.user.email);
      const ok = await verifyPassword(password, found?.passwordHash ?? null);
      if (!ok) {
        await writeAudit({
          actorId: req.auth!.user.id,
          actorType: 'USER',
          action: 'STEP_UP_FAILED',
          resourceType: 'session',
          resourceId: req.auth!.session.id,
          ipHash: clientIpHash(req),
        });
        return res.status(401).render('step-up', {
          title: 'Confirm password',
          next,
          error: 'Password is incorrect.',
        });
      }
      await elevateSession(req.auth!.session.id, 10);
      await writeAudit({
        actorId: req.auth!.user.id,
        actorType: 'USER',
        action: 'STEP_UP_GRANTED',
        resourceType: 'session',
        resourceId: req.auth!.session.id,
        metadata: { minutes: 10 },
        ipHash: clientIpHash(req),
      });
      res.redirect(`${next}${next.includes('?') ? '&' : '?'}notice=password-confirmed`);
    }),
  );

  router.get('/signup', (_req, res) => {
    res.status(404).render('error', {
      title: 'Accounts are created by an administrator',
      status: 404,
      message:
        'Merchant accounts are provisioned by an operator after KYC. There is no self-service sign-up for a payment platform.',
      requestId: '',
    });
  });

  return router;
}

export { AppError };
