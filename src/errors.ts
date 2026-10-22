export type ErrorCode =
  | 'VALIDATION_ERROR'
  | 'UNAUTHENTICATED'
  | 'FORBIDDEN'
  | 'NOT_FOUND'
  | 'CONFLICT'
  | 'RATE_LIMITED'
  | 'CSRF_FAILED'
  | 'STEP_UP_REQUIRED'
  | 'PROVIDER_NOT_CONFIGURED'
  | 'PROVIDER_UNAVAILABLE'
  | 'PROVIDER_AUTH_ERROR'
  | 'PROVIDER_RATE_LIMITED'
  | 'PROVIDER_VALIDATION_ERROR'
  | 'WEBHOOK_SIGNATURE_INVALID'
  | 'WEBHOOK_MALFORMED'
  | 'INVALID_STATE_TRANSITION'
  | 'AMOUNT_MISMATCH'
  | 'GMAIL_NOT_CONNECTED'
  | 'INTERNAL';

export class AppError extends Error {
  readonly code: ErrorCode;
  readonly statusCode: number;
  readonly details?: unknown;
  readonly expose: boolean;

  constructor(
    code: ErrorCode,
    message: string,
    statusCode = 400,
    options: { details?: unknown; expose?: boolean; cause?: unknown } = {},
  ) {
    super(message);
    this.name = 'AppError';
    this.code = code;
    this.statusCode = statusCode;
    this.details = options.details;
    this.expose = options.expose ?? statusCode < 500;
    if (options.cause) this.cause = options.cause;
  }
}

export function isAppError(err: unknown): err is AppError {
  return err instanceof AppError;
}

/** Provider errors are intentionally distinct from domain errors. */
export class ProviderError extends Error {
  readonly provider: string;
  readonly kind:
    | 'not_configured'
    | 'auth'
    | 'rate_limited'
    | 'unavailable'
    | 'validation'
    | 'unsupported'
    | 'malformed_response';
  readonly retryable: boolean;
  readonly details?: unknown;

  constructor(
    provider: string,
    kind: ProviderError['kind'],
    message: string,
    options: { retryable?: boolean; details?: unknown; cause?: unknown } = {},
  ) {
    super(message);
    this.name = 'ProviderError';
    this.provider = provider;
    this.kind = kind;
    this.retryable = options.retryable ?? (kind === 'unavailable' || kind === 'rate_limited');
    this.details = options.details;
    if (options.cause) this.cause = options.cause;
  }
}

export class WebhookSignatureError extends AppError {
  constructor(message = 'Webhook signature verification failed') {
    super('WEBHOOK_SIGNATURE_INVALID', message, 401);
  }
}
