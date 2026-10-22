/**
 * Test environment.
 *
 * Imported before any application module so config.ts sees a complete,
 * deterministic environment. These are throwaway local values, never secrets.
 */
const env: Record<string, string> = {
  NODE_ENV: 'test',
  PORT: '3001',
  APP_URL: 'http://localhost:3000',
  LOG_LEVEL: 'silent',
  DATABASE_URL: process.env.TEST_DATABASE_URL ?? 'postgresql://app:app@127.0.0.1:55432/payment_gateway_test',
  SESSION_SECRET: 'test-session-secret-0123456789-abcdefghijklmnop',
  TOKEN_ENCRYPTION_KEYS:
    'v1:AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=,v0:ICEiIyQlJicoKSorLC0uLzAxMjM0NTY3ODk6Ozw9Pj8=',
  COOKIE_SECURE: 'false',
  TRUST_PROXY: 'false',
  MAX_ORDER_AMOUNT_PAISE: '10000000',
  DEFAULT_ORDER_EXPIRY_MINUTES: '15',
  MATCHING_WINDOW_MINUTES: '180',
  RECONCILIATION_INTERVAL_SECONDS: '60',
  ALLOW_SANDBOX_PROVIDER: 'true',
  GMAIL_ALLOWED_SENDER_DOMAINS: 'hdfcbank.net,alerts.razorpay.com,icicibank.com',
  RETENTION_PAYMENT_EVENTS_DAYS: '180',
  RETENTION_AUDIT_LOGS_DAYS: '730',
};

const PROVIDER_SECRET_KEYS = [
  'RAZORPAY_KEY_ID',
  'RAZORPAY_KEY_SECRET',
  'RAZORPAY_WEBHOOK_SECRET',
  'CASHFREE_CLIENT_ID',
  'CASHFREE_CLIENT_SECRET',
  'CASHFREE_WEBHOOK_SECRET',
  'GOOGLE_CLIENT_ID',
  'GOOGLE_CLIENT_SECRET',
];

/**
 * Forces the deterministic test environment. Called before every test so a
 * test that mutates process.env (e.g. clearing the sender allowlist) cannot
 * leak state into the next test or the next file.
 */
export function resetTestEnv(): void {
  for (const [key, value] of Object.entries(env)) {
    process.env[key] = value;
  }
  // Tests must never talk to real providers, even if a developer's shell has keys.
  for (const key of PROVIDER_SECRET_KEYS) {
    delete process.env[key];
  }
}

resetTestEnv();

