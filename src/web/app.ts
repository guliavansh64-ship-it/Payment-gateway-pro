import path from 'node:path';
import express, { type Express } from 'express';
import cookieParser from 'cookie-parser';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import { getConfig } from '../config';
import { getLogger } from '../observability/logger';
import { attachSession } from './session';
import { errorHandler, notFound, requestId } from './middleware';
import * as helpers from './helpers';
import { authRouter } from './routes/auth';
import { customerRouter } from './routes/customer';
import { dashboardRouter } from './routes/dashboard';
import { adminRouter } from './routes/admin';
import { webhookRouter } from './routes/webhooks';
import { oauthRouter } from './routes/oauth';
import { apiRouter } from './routes/api';
import { providerPublicInfo } from '../providers/registry';

export function createApp(options: { viewsDir?: string; publicDir?: string } = {}): Express {
  const config = getConfig();
  const app = express();

  app.disable('x-powered-by');
  app.set('trust proxy', config.trustProxy ? 1 : false);
  app.set('view engine', 'ejs');
  app.set('views', options.viewsDir ?? path.join(__dirname, 'views'));
  app.set('query parser', 'simple');

  app.use(requestId);

  app.use(
    helmet({
      contentSecurityPolicy: {
        useDefaults: true,
        directives: {
          'default-src': ["'self'"],
          'script-src': ["'self'"],
          // Templates use a handful of inline width/colour styles; no inline
          // <script> is ever emitted.
          'style-src': ["'self'", "'unsafe-inline'"],
          'img-src': ["'self'", 'data:'],
          'font-src': ["'self'"],
          'connect-src': ["'self'"],
          'form-action': ["'self'"],
          'frame-ancestors': config.resolvedFrameAncestors,
          'base-uri': ["'self'"],
          'object-src': ["'none'"],
          'upgrade-insecure-requests': config.isProduction ? [] : null,
        },
      },
      crossOriginEmbedderPolicy: false,
      // frame-ancestors is the modern control; X-Frame-Options is disabled
      // outside production so an explicit CSP override can allow embedding.
      xFrameOptions: config.isProduction ? { action: 'deny' } : false,
      referrerPolicy: { policy: 'same-origin' },
      hsts: config.isProduction ? { maxAge: 31_536_000, includeSubDomains: true } : false,
    }),
  );

  app.use(
    express.static(options.publicDir ?? path.join(__dirname, 'public'), {
      maxAge: config.isProduction ? '7d' : 0,
      etag: true,
      setHeaders: (res, filePath) => {
        if (filePath.endsWith('.js') || filePath.endsWith('.css')) {
          res.setHeader('Cache-Control', config.isProduction ? 'public, max-age=604800' : 'no-cache');
        }
      },
    }),
  );

  app.use(cookieParser(config.sessionSecret));

  // Webhooks need the unparsed body for signature verification, so they are
  // mounted before the JSON/urlencoded parsers.
  app.use('/webhooks', webhookRouter());

  app.use(express.urlencoded({ extended: false, limit: '64kb' }));
  app.use(express.json({ limit: '64kb' }));

  app.use(
    rateLimit({
      windowMs: 60_000,
      limit: 240,
      standardHeaders: 'draft-7',
      legacyHeaders: false,
      skip: (req) => req.path === '/healthz' || req.path === '/readyz',
      message: 'Too many requests. Please slow down.',
    }),
  );

  app.use(attachSession);

  app.use((req, res, next) => {
    res.locals.currentPath = req.path;
    res.locals.user = req.auth?.user ?? null;
    res.locals.csrfToken = req.auth?.csrfToken ?? '';
    res.locals.notice = helpers.noticeFor(req.query.notice);
    res.locals.errorNotice = helpers.errorFor(req.query.error);
    res.locals.appName = 'UPI Verify';
    res.locals.isProduction = config.isProduction;
    res.locals.isAdmin = req.auth?.user.role === 'ADMIN';
    res.locals.isAuditor = req.auth?.user.role === 'AUDITOR';
    res.locals.merchant = req.merchant ?? null;
    res.locals.providers = providerPublicInfo();
    res.locals.sandboxEnabled = config.allowSandboxProvider && !config.isProduction;
    next();
  });

  // View helpers
  Object.assign(app.locals, helpers);

  app.use('/api', apiRouter());
  app.use('/', authRouter());
  app.use('/', customerRouter());
  app.use('/', oauthRouter());
  app.use('/dashboard', dashboardRouter());
  app.use('/admin', adminRouter());

  app.get('/healthz', (_req, res) => {
    res.json({ status: 'ok', uptime: Math.round(process.uptime()), version: process.env.npm_package_version ?? 'dev' });
  });

  app.get('/readyz', async (_req, res) => {
    try {
      const { query } = await import('../db/pool');
      await query('SELECT 1');
      res.json({ status: 'ready', database: 'ok' });
    } catch {
      res.status(503).json({ status: 'not-ready', database: 'unavailable' });
    }
  });

  app.use(notFound);
  app.use(errorHandler);

  getLogger().debug('express app configured', { env: config.nodeEnv });
  return app;
}
