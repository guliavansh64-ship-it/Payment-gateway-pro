import type { NextFunction, Request, Response } from 'express';
import { randomBytes } from 'node:crypto';
import { getConfig } from '../config';
import { findSessionByTokenHash, revokeSession, touchSession } from '../repos/accounts';
import { opaqueHash } from '../security/crypto';
import { AppError } from '../errors';

export const SESSION_COOKIE = 'sid';
export const CSRF_COOKIE = 'csrf';
export const OAUTH_COOKIE = 'oauth_state';

const SESSION_TTL_MS = 8 * 60 * 60 * 1000;

export function sessionCookieOptions(): {
  httpOnly: boolean;
  secure: boolean;
  sameSite: 'lax' | 'strict' | 'none';
  path: string;
  maxAge: number;
} {
  return {
    httpOnly: true,
    secure: getConfig().cookieSecure,
    sameSite: getConfig().cookieSameSite,
    path: '/',
    maxAge: SESSION_TTL_MS,
  };
}

export function csrfCookieOptions(): {
  httpOnly: boolean;
  secure: boolean;
  sameSite: 'lax' | 'strict' | 'none';
  path: string;
  maxAge: number;
} {
  return { ...sessionCookieOptions(), maxAge: SESSION_TTL_MS };
}

export function newSessionToken(): string {
  return randomBytes(32).toString('base64url');
}

export function newCsrfToken(): string {
  return randomBytes(24).toString('base64url');
}

export function hashToken(token: string): string {
  return opaqueHash(token);
}

/**
 * Loads the session from the opaque cookie. Only the hash is stored server-side,
 * so a database leak cannot be replayed as a live session.
 */
export async function attachSession(req: Request, _res: Response, next: NextFunction): Promise<void> {
  try {
    const token = req.cookies?.[SESSION_COOKIE];
    if (typeof token === 'string' && token.length > 20) {
      const found = await findSessionByTokenHash(hashToken(token));
      if (
        found &&
        !found.session.revokedAt &&
        found.session.expiresAt.getTime() > Date.now() &&
        found.user.isActive
      ) {
        const csrfToken = req.cookies?.[CSRF_COOKIE];
        if (typeof csrfToken === 'string') {
          req.auth = { user: found.user, session: found.session, csrfToken };
          void touchSession(found.session.id).catch(() => undefined);
        }
      }
    }
    next();
  } catch (err) {
    next(err);
  }
}

/**
 * Synchroniser-style CSRF check: the submitted token must equal the HttpOnly
 * cookie AND hash to the value bound to the session at login.
 * Webhooks and machine endpoints are exempt (they authenticate differently).
 */
export function requireCsrf(req: Request, _res: Response, next: NextFunction): void {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
  if (req.path.startsWith('/webhooks/')) return next();
  if (!req.auth) return next(new AppError('UNAUTHENTICATED', 'Not signed in', 401));

  const submitted =
    (typeof req.body?._csrf === 'string' && req.body._csrf) ||
    (typeof req.get('x-csrf-token') === 'string' && req.get('x-csrf-token')) ||
    '';
  const cookieToken = req.cookies?.[CSRF_COOKIE] ?? '';
  const expectedHash = req.auth.session.csrfTokenHash;

  if (
    !submitted ||
    !cookieToken ||
    submitted.length !== cookieToken.length ||
    submitted !== cookieToken ||
    hashToken(submitted) !== expectedHash
  ) {
    return next(new AppError('CSRF_FAILED', 'Your session token expired. Refresh the page and try again.', 403));
  }
  next();
}

export function sessionExpiry(): Date {
  return new Date(Date.now() + SESSION_TTL_MS);
}

export async function destroySession(req: Request, res: Response): Promise<void> {
  if (req.auth) await revokeSession(req.auth.session.id);
  res.clearCookie(SESSION_COOKIE, { path: '/' });
  res.clearCookie(CSRF_COOKIE, { path: '/' });
  req.auth = undefined;
}
