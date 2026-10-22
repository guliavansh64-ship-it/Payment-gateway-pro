import { z } from 'zod';

/**
 * Runtime configuration.
 *
 * Secrets are read from the environment (or a managed secret store that injects
 * them as environment variables). Nothing here is sent to the browser.
 */

const boolFromString = z
  .enum(['true', 'false', '1', '0'])
  .transform((v) => v === 'true' || v === '1');

const intFromString = (min: number, max: number) =>
  z
    .string()
    .regex(/^\d+$/, 'must be a non-negative integer')
    .transform(Number)
    .pipe(z.number().int().min(min).max(max));

const optionalString = z
  .string()
  .optional()
  .transform((v) => (v && v.trim().length > 0 ? v.trim() : undefined));

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: intFromString(1, 65535).default('3000'),
  APP_URL: z.string().url(),
  TRUST_PROXY: boolFromString.default('false'),
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error', 'silent']).default('info'),

  DATABASE_URL: z.string().min(1),
  PGSSLMODE: z.enum(['disable', 'require', 'verify-full']).default('disable'),
  DB_POOL_MAX: intFromString(1, 100).default('10'),

  SESSION_SECRET: z.string().min(32),
  TOKEN_ENCRYPTION_KEYS: z.string().min(1),
  COOKIE_SECURE: boolFromString.default('false'),

  MAX_ORDER_AMOUNT_PAISE: intFromString(100, 100_000_000).default('10000000'),
  DEFAULT_ORDER_EXPIRY_MINUTES: intFromString(2, 1440).default('15'),
  MATCHING_WINDOW_MINUTES: intFromString(5, 1440).default('180'),
  RECONCILIATION_INTERVAL_SECONDS: intFromString(15, 3600).default('120'),
  RUN_BACKGROUND_JOBS: boolFromString.default('false'),

  RAZORPAY_KEY_ID: optionalString,
  RAZORPAY_KEY_SECRET: optionalString,
  RAZORPAY_WEBHOOK_SECRET: optionalString,
  RAZORPAY_MODE: z.enum(['test', 'live']).default('test'),

  CASHFREE_CLIENT_ID: optionalString,
  CASHFREE_CLIENT_SECRET: optionalString,
  CASHFREE_WEBHOOK_SECRET: optionalString,
  CASHFREE_MODE: z.enum(['sandbox', 'production']).default('sandbox'),

  ALLOW_SANDBOX_PROVIDER: boolFromString.default('false'),

  GOOGLE_CLIENT_ID: optionalString,
  GOOGLE_CLIENT_SECRET: optionalString,
  GOOGLE_OAUTH_REDIRECT_URI: optionalString,
  GOOGLE_PUBSUB_TOPIC: optionalString,
  GMAIL_POLL_INTERVAL_SECONDS: intFromString(30, 86400).default('300'),
  GMAIL_ALLOWED_SENDER_DOMAINS: z.string().default(''),

  RETENTION_PAYMENT_EVENTS_DAYS: intFromString(30, 3650).default('180'),
  RETENTION_AUDIT_LOGS_DAYS: intFromString(90, 3650).default('730'),
});

export type AppConfig = ReturnType<typeof buildConfig>;

function buildConfig(env: z.infer<typeof envSchema>) {
  const isProduction = env.NODE_ENV === 'production';
  const keys = parseEncryptionKeys(env.TOKEN_ENCRYPTION_KEYS);

  if (isProduction) {
    if (!env.APP_URL.startsWith('https://')) {
      throw new Error('APP_URL must use https:// in production');
    }
    if (!env.COOKIE_SECURE) {
      throw new Error('COOKIE_SECURE must be true in production');
    }
    if (env.SESSION_SECRET.startsWith('replace-me')) {
      throw new Error('SESSION_SECRET must be replaced in production');
    }
    if (env.ALLOW_SANDBOX_PROVIDER) {
      throw new Error('ALLOW_SANDBOX_PROVIDER must be false in production');
    }
    if (env.RAZORPAY_KEY_ID && !env.RAZORPAY_WEBHOOK_SECRET) {
      throw new Error('RAZORPAY_WEBHOOK_SECRET is required when Razorpay is configured');
    }
    if (env.CASHFREE_CLIENT_ID && !env.CASHFREE_WEBHOOK_SECRET) {
      throw new Error('CASHFREE_WEBHOOK_SECRET is required when Cashfree is configured');
    }
    if (env.GOOGLE_CLIENT_ID && !env.GOOGLE_OAUTH_REDIRECT_URI?.startsWith('https://')) {
      throw new Error('GOOGLE_OAUTH_REDIRECT_URI must use https:// in production');
    }
  }

  return {
    nodeEnv: env.NODE_ENV,
    isProduction,
    isTest: env.NODE_ENV === 'test',
    port: env.PORT,
    appUrl: env.APP_URL.replace(/\/$/, ''),
    trustProxy: env.TRUST_PROXY,
    logLevel: env.LOG_LEVEL,
    databaseUrl: env.DATABASE_URL,
    pgSslMode: env.PGSSLMODE,
    dbPoolMax: env.DB_POOL_MAX,
    sessionSecret: env.SESSION_SECRET,
    encryptionKeys: keys,
    cookieSecure: env.COOKIE_SECURE,
    maxOrderAmountPaise: env.MAX_ORDER_AMOUNT_PAISE,
    defaultOrderExpiryMinutes: env.DEFAULT_ORDER_EXPIRY_MINUTES,
    matchingWindowMinutes: env.MATCHING_WINDOW_MINUTES,
    reconciliationIntervalSeconds: env.RECONCILIATION_INTERVAL_SECONDS,
    runBackgroundJobs: env.RUN_BACKGROUND_JOBS,
    razorpay: {
      keyId: env.RAZORPAY_KEY_ID,
      keySecret: env.RAZORPAY_KEY_SECRET,
      webhookSecret: env.RAZORPAY_WEBHOOK_SECRET,
      mode: env.RAZORPAY_MODE,
    },
    cashfree: {
      clientId: env.CASHFREE_CLIENT_ID,
      clientSecret: env.CASHFREE_CLIENT_SECRET,
      webhookSecret: env.CASHFREE_WEBHOOK_SECRET,
      mode: env.CASHFREE_MODE,
    },
    allowSandboxProvider: env.ALLOW_SANDBOX_PROVIDER,
    google: {
      clientId: env.GOOGLE_CLIENT_ID,
      clientSecret: env.GOOGLE_CLIENT_SECRET,
      redirectUri: env.GOOGLE_OAUTH_REDIRECT_URI,
      pubsubTopic: env.GOOGLE_PUBSUB_TOPIC,
    },
    gmailPollIntervalSeconds: env.GMAIL_POLL_INTERVAL_SECONDS,
    gmailAllowedSenderDomains: env.GMAIL_ALLOWED_SENDER_DOMAINS.split(',')
      .map((d) => d.trim().toLowerCase())
      .filter((d) => /^[a-z0-9.-]+\.[a-z]{2,}$/.test(d)),
    retention: {
      paymentEventsDays: env.RETENTION_PAYMENT_EVENTS_DAYS,
      auditLogsDays: env.RETENTION_AUDIT_LOGS_DAYS,
    },
  };
}

export type EncryptionKey = { version: string; key: Buffer };

function parseEncryptionKeys(raw: string): EncryptionKey[] {
  const parts = raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const keys: EncryptionKey[] = [];
  for (const part of parts) {
    const [version, b64] = part.split(':');
    if (!version || !b64) {
      throw new Error('TOKEN_ENCRYPTION_KEYS entries must look like v1:<base64-32-bytes>');
    }
    const key = Buffer.from(b64, 'base64');
    if (key.length !== 32) {
      throw new Error(`Encryption key ${version} must decode to exactly 32 bytes`);
    }
    keys.push({ version, key });
  }
  if (keys.length === 0) throw new Error('At least one TOKEN_ENCRYPTION_KEYS entry is required');
  return keys;
}

let cached: AppConfig | null = null;

export function getConfig(): AppConfig {
  if (!cached) {
    const parsed = envSchema.safeParse(process.env);
    if (!parsed.success) {
      const issues = parsed.error.issues
        .map((i) => `${i.path.join('.')}: ${i.message}`)
        .join('; ');
      throw new Error(`Invalid environment configuration: ${issues}`);
    }
    cached = buildConfig(parsed.data);
  }
  return cached;
}

/** Test helper: clears the memoised config after mutating process.env. */
export function resetConfigCache(): void {
  cached = null;
}

export function isProviderConfigured(
  name: 'razorpay' | 'cashfree' | 'sandbox' | 'manual_upi',
): boolean {
  const c = getConfig();
  switch (name) {
    case 'razorpay':
      return Boolean(c.razorpay.keyId && c.razorpay.keySecret && c.razorpay.webhookSecret);
    case 'cashfree':
      return Boolean(c.cashfree.clientId && c.cashfree.clientSecret && c.cashfree.webhookSecret);
    case 'sandbox':
      return c.allowSandboxProvider && !c.isProduction;
    case 'manual_upi':
      return true;
  }
}
