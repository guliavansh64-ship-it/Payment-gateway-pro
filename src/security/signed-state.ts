import { createHmac, timingSafeEqual } from 'node:crypto';
import { getConfig } from '../config';

/**
 * Signed, short-lived payloads for OAuth round-trips.
 *
 * The OAuth state parameter protects against login CSRF; the PKCE code
 * verifier is kept inside this signed cookie instead of server memory so it
 * works across instances. Payloads are HMAC-SHA256 signed with a key derived
 * from SESSION_SECRET and expire after 10 minutes.
 */

export type OAuthStatePayload = {
  state: string;
  codeVerifier: string;
  userId: string;
  redirectTo: string;
  exp: number;
};

export function signState(payload: OAuthStatePayload): string {
  const body = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  const sig = sign(body);
  return `${body}.${sig}`;
}

export function verifyState(token: string, maxAgeMs = 10 * 60_000): OAuthStatePayload | null {
  const parts = token.split('.');
  if (parts.length !== 2) return null;
  const [body, sig] = parts as [string, string];
  const expected = sign(body);
  const a = Buffer.from(sig, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  try {
    const parsed = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as OAuthStatePayload;
    if (typeof parsed.exp !== 'number' || Date.now() > parsed.exp) return null;
    if (Date.now() - parsed.exp > maxAgeMs) return null;
    return parsed;
  } catch {
    return null;
  }
}

function sign(body: string): string {
  const key = createHmac('sha256', getConfig().sessionSecret).update('oauth-state-v1').digest();
  return createHmac('sha256', key).update(body).digest('base64url');
}
