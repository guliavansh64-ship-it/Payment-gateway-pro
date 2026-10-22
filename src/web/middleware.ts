import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { randomUUID } from 'node:crypto';
import { ZodError } from 'zod';
import { AppError, ProviderError, isAppError } from '../errors';
import { getLogger } from '../observability/logger';
import { findMerchantByOwner } from '../repos/merchants';
import { opaqueHash } from '../security/crypto';
import type { UserRole } from '../domain/models';

export function asyncHandler(
  fn: (req: Request, res: Response, next: NextFunction) => Promise<unknown>,
): RequestHandler {
  return (req, res, next) => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
}

export function requestId(req: Request, res: Response, next: NextFunction): void {
  req.requestId = req.get('x-request-id')?.slice(0, 64) ?? randomUUID();
  res.setHeader('X-Request-Id', req.requestId);
  next();
}

export function clientIpHash(req: Request): string {
  const ip = req.ip ?? 'unknown';
  return opaqueHash(`ip:${ip}`);
}

export function requireAuth(roles?: UserRole[]): RequestHandler {
  return (req, res, next) => {
    if (!req.auth) {
      // `req.path` is relative to the router mount point, so use the original URL.
      if (req.originalUrl.startsWith('/api/') || req.accepts(['html', 'json']) === 'json') {
        return next(new AppError('UNAUTHENTICATED', 'Sign in required', 401));
      }
      const target = encodeURIComponent(req.originalUrl);
      return res.redirect(`/login?next=${target}`);
    }
    if (roles && !roles.includes(req.auth.user.role)) {
      return next(new AppError('FORBIDDEN', 'Your role cannot access this page', 403));
    }
    return next();
  };
}

/** Loads the merchant owned by the signed-in user (admins may target another). */
export function loadMerchant(): RequestHandler {
  return asyncHandler(async (req, _res, next) => {
    if (!req.auth) return next(new AppError('UNAUTHENTICATED', 'Sign in required', 401));
    if (req.auth.user.role === 'ADMIN' || req.auth.user.role === 'AUDITOR') {
      // Admins browse cross-merchant views by default; individual pages resolve
      // the merchant from the resource being viewed.
      return next();
    }
    const merchant = await findMerchantByOwner(req.auth.user.id);
    if (!merchant) return next(new AppError('FORBIDDEN', 'No merchant account is linked to your user', 403));
    req.merchant = merchant;
    next();
  });
}

export function requireStepUp(minutes = 10): RequestHandler {
  return (req, _res, next) => {
    if (!req.auth) return next(new AppError('UNAUTHENTICATED', 'Sign in required', 401));
    const elevated = req.auth.session.elevatedUntil?.getTime() ?? 0;
    if (elevated < Date.now()) {
      return next(
        new AppError(
          'STEP_UP_REQUIRED',
          'This action requires re-authentication. Confirm your password to continue.',
          403,
        ),
      );
    }
    if (elevated - Date.now() > minutes * 60_000) {
      return next(new AppError('FORBIDDEN', 'Invalid elevation window', 403));
    }
    next();
  };
}

export function notFound(req: Request, res: Response): void {
  if (req.path.startsWith('/api/') || req.path.startsWith('/webhooks/')) {
    res.status(404).json({ error: 'Not found', requestId: req.requestId });
    return;
  }
  res.status(404).render('error', {
    title: 'Not found',
    status: 404,
    message: 'The page you are looking for does not exist.',
    requestId: req.requestId,
  });
}

export function errorHandler(err: unknown, req: Request, res: Response, _next: NextFunction): void {
  const logger = getLogger().child({ requestId: req.requestId, path: req.path });
  let status = 500;
  let code = 'INTERNAL';
  let message = 'Something went wrong. No payment state was changed.';
  let details: unknown = undefined;

  if (isAppError(err)) {
    status = err.statusCode;
    code = err.code;
    message = err.expose ? err.message : message;
    details = err.details;
  } else if (err instanceof ZodError) {
    status = 400;
    code = 'VALIDATION_ERROR';
    message = err.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
  } else if (err instanceof ProviderError) {
    status = err.kind === 'auth' ? 502 : 503;
    code = 'PROVIDER_UNAVAILABLE';
    message = 'The payment provider is temporarily unavailable. Please try again.';
    logger.warn('provider error', { provider: err.provider, kind: err.kind, error: err.message });
  } else if (err instanceof Error) {
    logger.error('unhandled error', { error: err.message, stack: err.stack?.slice(0, 1500) });
  }

  if (status >= 500 && !(err instanceof ProviderError)) {
    logger.error('request failed', { error: err instanceof Error ? err.message : String(err) });
  }

  const wantsJson = req.path.startsWith('/api/') || req.path.startsWith('/webhooks/') ||
    req.accepts(['html', 'json']) === 'json';
  if (wantsJson) {
    res.status(status).json({ error: message, code, requestId: req.requestId, details });
    return;
  }
  res.status(status).render('error', {
    title: status === 403 ? 'Access denied' : status === 404 ? 'Not found' : 'Something went wrong',
    status,
    message,
    requestId: req.requestId,
  });
}
