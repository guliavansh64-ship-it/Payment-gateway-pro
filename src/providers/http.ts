import { ProviderError } from '../errors';

/**
 * HTTP transport for provider APIs.
 *
 * Rules:
 *  - every call has a hard timeout
 *  - only idempotent reads are retried automatically; writes are retried only
 *    when the provider documents an idempotency key (see `idempotent` flag)
 *  - response bodies are never logged at info level
 */

export type HttpRequest = {
  method: 'GET' | 'POST' | 'PUT' | 'PATCH';
  url: string;
  headers?: Record<string, string>;
  body?: unknown;
  timeoutMs?: number;
  provider: string;
  /** Safe to retry on network/5xx errors. */
  idempotent?: boolean;
  maxAttempts?: number;
  /** Injectable for tests. */
  fetchImpl?: typeof fetch;
};

const DEFAULT_TIMEOUT_MS = 10_000;

export async function requestJson<T = unknown>(req: HttpRequest): Promise<{
  status: number;
  body: T;
  headers: Headers;
}> {
  const fetchImpl = req.fetchImpl ?? fetch;
  const attempts = req.idempotent ? Math.min(req.maxAttempts ?? 3, 3) : 1;
  let lastError: unknown = null;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), req.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    try {
      const res = await fetchImpl(req.url, {
        method: req.method,
        headers: {
          Accept: 'application/json',
          ...(req.body === undefined ? {} : { 'Content-Type': 'application/json' }),
          ...req.headers,
        },
        body: req.body === undefined ? undefined : JSON.stringify(req.body),
        signal: controller.signal,
        // Never follow cross-origin redirects with credentials attached.
        redirect: 'error',
      });
      const text = await res.text();
      let parsed: unknown = null;
      if (text.length > 0) {
        try {
          parsed = JSON.parse(text);
        } catch {
          parsed = { raw: text.slice(0, 500) };
        }
      }
      if (res.status === 401 || res.status === 403) {
        throw new ProviderError(req.provider, 'auth', `Provider rejected credentials (${res.status})`, {
          retryable: false,
          details: parsed,
        });
      }
      if (res.status === 429) {
        throw new ProviderError(req.provider, 'rate_limited', 'Provider rate limit hit', {
          retryable: true,
          details: parsed,
        });
      }
      if (res.status >= 500) {
        throw new ProviderError(req.provider, 'unavailable', `Provider returned ${res.status}`, {
          retryable: true,
          details: parsed,
        });
      }
      return { status: res.status, body: parsed as T, headers: res.headers };
    } catch (err) {
      if (err instanceof ProviderError) {
        lastError = err;
        if (!err.retryable || attempt === attempts) throw err;
      } else {
        const aborted = err instanceof Error && err.name === 'AbortError';
        lastError = err;
        if (!req.idempotent || attempt === attempts) {
          throw new ProviderError(
            req.provider,
            'unavailable',
            aborted ? 'Provider request timed out' : 'Provider request failed',
            { retryable: true, cause: err },
          );
        }
      }
      await sleep(200 * 2 ** (attempt - 1));
    } finally {
      clearTimeout(timer);
    }
  }
  throw new ProviderError(
    req.provider,
    'unavailable',
    lastError instanceof Error ? lastError.message : 'Provider request failed',
    { retryable: true, cause: lastError },
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
