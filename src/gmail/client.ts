import { ProviderError } from '../errors';

/**
 * Minimal Gmail API client (read-only).
 *
 * Only the endpoints needed for polling are implemented:
 *   users.me.getProfile, users.messages.list/get, users.history.list, users.watch
 * Polling is the default notification mechanism; `watch` + Pub/Sub is optional
 * and requires a configured topic.
 */

const BASE = 'https://gmail.googleapis.com/gmail/v1/users/me';

export type GmailMessageSummary = { id: string; threadId: string; internalDate?: string };

export type GmailPart = {
  mimeType?: string;
  headers?: Array<{ name?: string; value?: string }>;
  body?: { data?: string; size?: number };
  parts?: GmailPart[];
};

export type GmailMessage = {
  id: string;
  threadId: string;
  internalDate?: string;
  labelIds?: string[];
  payload?: GmailPart;
};

export class GmailApiError extends Error {
  constructor(
    readonly statusCode: number,
    message: string,
  ) {
    super(message);
    this.name = 'GmailApiError';
  }
}

export class GmailClient {
  constructor(
    private readonly accessToken: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  private async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const res = await this.fetchImpl(`${BASE}${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${this.accessToken}`,
        Accept: 'application/json',
        ...(init.body ? { 'Content-Type': 'application/json' } : {}),
        ...(init.headers ?? {}),
      },
      signal: AbortSignal.timeout(20_000),
    });
    if (res.status === 401) throw new GmailApiError(401, 'Gmail access token rejected');
    if (res.status === 403) throw new GmailApiError(403, 'Gmail API permission denied');
    if (res.status === 404) throw new GmailApiError(404, 'Gmail resource not found');
    if (res.status === 429) throw new GmailApiError(429, 'Gmail API rate limited');
    if (!res.ok) throw new GmailApiError(res.status, `Gmail API returned ${res.status}`);
    if (res.status === 204) return {} as T;
    return (await res.json()) as T;
  }

  getProfile(): Promise<{ emailAddress: string; historyId: string; messagesTotal: number }> {
    return this.request('/profile');
  }

  listMessages(input: { query: string; maxResults: number; pageToken?: string }): Promise<{
    messages?: GmailMessageSummary[];
    nextPageToken?: string;
    resultSizeEstimate?: number;
  }> {
    const params = new URLSearchParams({
      q: input.query,
      maxResults: String(Math.min(Math.max(input.maxResults, 1), 100)),
    });
    if (input.pageToken) params.set('pageToken', input.pageToken);
    return this.request(`/messages?${params.toString()}`);
  }

  getMessage(id: string): Promise<GmailMessage> {
    return this.request(`/messages/${encodeURIComponent(id)}?format=full`);
  }

  listHistory(startHistoryId: string): Promise<{
    history?: Array<{
      id: string;
      messagesAdded?: Array<{ message: GmailMessageSummary }>;
    }>;
    nextPageToken?: string;
    historyId?: string;
  }> {
    const params = new URLSearchParams({
      startHistoryId,
      historyTypes: 'messageAdded',
      maxResults: '100',
    });
    return this.request(`/history?${params.toString()}`);
  }

  watch(topicName: string): Promise<{ historyId: string; expiration: string }> {
    return this.request('/watch', {
      method: 'POST',
      body: JSON.stringify({ topicName, labelIds: ['INBOX'] }),
    });
  }
}

/** Header lookup is case-insensitive; Gmail preserves the sender's casing. */
export function getHeader(message: GmailMessage, name: string): string {
  const headers = message.payload?.headers ?? [];
  const lower = name.toLowerCase();
  for (const h of headers) {
    if ((h.name ?? '').toLowerCase() === lower) return h.value ?? '';
  }
  return '';
}

export function messageReceivedAt(message: GmailMessage): Date {
  const internal = message.internalDate ? Number(message.internalDate) : NaN;
  if (Number.isFinite(internal)) return new Date(internal);
  const dateHeader = getHeader(message, 'Date');
  const parsed = Date.parse(dateHeader);
  return Number.isFinite(parsed) ? new Date(parsed) : new Date();
}

export function assertGmailConfigured(configured: boolean): void {
  if (!configured) {
    throw new ProviderError('google', 'not_configured', 'Google OAuth is not configured');
  }
}
