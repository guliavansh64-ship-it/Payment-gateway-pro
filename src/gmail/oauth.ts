import { randomBytes, createHash } from 'node:crypto';
import { getConfig } from '../config';
import { AppError, ProviderError } from '../errors';

/**
 * Google OAuth 2.0 (authorization code + PKCE).
 *
 * Scope requested: gmail.readonly (a Google *restricted* scope) plus openid and
 * email so we can show which mailbox is connected.
 *
 * IMPORTANT for production: an app using a restricted Gmail scope must complete
 * Google's OAuth verification and, for `gmail.readonly`, a security assessment.
 * The connected user must also be allowed to grant the scope. See
 * docs/GOOGLE_OAUTH_CHECKLIST.md. The platform never asks for a Google password
 * or an app password.
 */

const AUTH_ENDPOINT = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';
const REVOKE_ENDPOINT = 'https://oauth2.googleapis.com/revoke';
const USERINFO_ENDPOINT = 'https://openidconnect.googleapis.com/v1/userinfo';

export const GMAIL_SCOPES = [
  'https://www.googleapis.com/auth/gmail.readonly',
  'openid',
  'email',
] as const;

export type OAuthTokens = {
  accessToken: string;
  refreshToken: string | null;
  expiresInSeconds: number;
  scope: string;
  tokenType: string;
};

export function isGoogleConfigured(): boolean {
  const g = getConfig().google;
  return Boolean(g.clientId && g.clientSecret && g.redirectUri);
}

export function buildAuthUrl(input: { state: string; codeChallenge: string }): string {
  const g = getConfig().google;
  if (!isGoogleConfigured()) {
    throw new AppError('PROVIDER_NOT_CONFIGURED', 'Google OAuth is not configured', 503);
  }
  const params = new URLSearchParams({
    client_id: g.clientId!,
    redirect_uri: g.redirectUri!,
    response_type: 'code',
    scope: GMAIL_SCOPES.join(' '),
    access_type: 'offline', // request a refresh token
    prompt: 'consent', // force refresh token issuance on re-connect
    include_granted_scopes: 'true',
    state: input.state,
    code_challenge: input.codeChallenge,
    code_challenge_method: 'S256',
  });
  return `${AUTH_ENDPOINT}?${params.toString()}`;
}

export function createPkcePair(): { verifier: string; challenge: string } {
  const verifier = randomBytes(32).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  return { verifier, challenge };
}

export function createState(): string {
  return randomBytes(24).toString('base64url');
}

async function tokenRequest(body: Record<string, string>, fetchImpl: typeof fetch = fetch): Promise<OAuthTokens> {
  const res = await fetchImpl(TOKEN_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(body).toString(),
    signal: AbortSignal.timeout(15_000),
  });
  const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) {
    // Never include the response body in errors: it can echo client secrets.
    throw new ProviderError('google', res.status === 400 ? 'auth' : 'unavailable', `Google token endpoint returned ${res.status}`, {
      retryable: res.status >= 500,
      details: { error: typeof json.error === 'string' ? json.error : 'unknown' },
    });
  }
  const accessToken = typeof json.access_token === 'string' ? json.access_token : null;
  if (!accessToken) throw new ProviderError('google', 'malformed_response', 'Google token response missing access_token');
  return {
    accessToken,
    refreshToken: typeof json.refresh_token === 'string' ? json.refresh_token : null,
    expiresInSeconds: typeof json.expires_in === 'number' ? json.expires_in : 3600,
    scope: typeof json.scope === 'string' ? json.scope : '',
    tokenType: typeof json.token_type === 'string' ? json.token_type : 'Bearer',
  };
}

export async function exchangeAuthorizationCode(input: {
  code: string;
  codeVerifier: string;
  fetchImpl?: typeof fetch;
}): Promise<OAuthTokens> {
  const g = getConfig().google;
  if (!isGoogleConfigured()) {
    throw new AppError('PROVIDER_NOT_CONFIGURED', 'Google OAuth is not configured', 503);
  }
  return tokenRequest(
    {
      code: input.code,
      client_id: g.clientId!,
      client_secret: g.clientSecret!,
      redirect_uri: g.redirectUri!,
      grant_type: 'authorization_code',
      code_verifier: input.codeVerifier,
    },
    input.fetchImpl,
  );
}

export async function refreshAccessToken(
  refreshToken: string,
  fetchImpl: typeof fetch = fetch,
): Promise<OAuthTokens> {
  const g = getConfig().google;
  if (!isGoogleConfigured()) {
    throw new AppError('PROVIDER_NOT_CONFIGURED', 'Google OAuth is not configured', 503);
  }
  const tokens = await tokenRequest(
    {
      refresh_token: refreshToken,
      client_id: g.clientId!,
      client_secret: g.clientSecret!,
      grant_type: 'refresh_token',
    },
    fetchImpl,
  );
  return { ...tokens, refreshToken: tokens.refreshToken ?? refreshToken };
}

export async function fetchUserEmail(accessToken: string, fetchImpl: typeof fetch = fetch): Promise<string> {
  const res = await fetchImpl(USERINFO_ENDPOINT, {
    headers: { Authorization: `Bearer ${accessToken}` },
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) {
    throw new ProviderError('google', 'auth', 'Could not read the connected account identity');
  }
  const json = (await res.json().catch(() => ({}))) as { email?: string; verified_email?: boolean };
  if (!json.email || json.verified_email === false) {
    throw new ProviderError('google', 'auth', 'Connected Google account has no verified email');
  }
  return json.email.toLowerCase();
}

/** Revokes the refresh token at Google. Best-effort: local state is cleared regardless. */
export async function revokeToken(token: string, fetchImpl: typeof fetch = fetch): Promise<boolean> {
  try {
    const res = await fetchImpl(`${REVOKE_ENDPOINT}?token=${encodeURIComponent(token)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      signal: AbortSignal.timeout(10_000),
    });
    return res.ok;
  } catch {
    return false;
  }
}
