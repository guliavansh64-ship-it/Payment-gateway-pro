import { formatPaiseInr } from '../domain/money';
import { ORDER_STATUSES, STATUS_LABELS, STATUS_TONES, type OrderStatus } from '../domain/status';

/** Presentation helpers shared by all EJS views. Kept free of business rules. */

const IST = 'Asia/Kolkata';

export function formatMoney(paise: number | null | undefined): string {
  if (paise === null || paise === undefined) return '—';
  return formatPaiseInr(paise);
}

export function formatDate(value: Date | string | null | undefined): string {
  if (!value) return '—';
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return '—';
  return new Intl.DateTimeFormat('en-IN', {
    dateStyle: 'medium',
    timeStyle: 'short',
    timeZone: IST,
  }).format(d);
}

export function formatDateOnly(value: Date | string | null | undefined): string {
  if (!value) return '—';
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return '—';
  return new Intl.DateTimeFormat('en-IN', { dateStyle: 'medium', timeZone: IST }).format(d);
}

export function isoDate(value: Date | string | null | undefined): string {
  if (!value) return '';
  const d = value instanceof Date ? value : new Date(value);
  return Number.isNaN(d.getTime()) ? '' : d.toISOString();
}

export function relativeTime(value: Date | string | null | undefined): string {
  if (!value) return '—';
  const d = value instanceof Date ? value : new Date(value);
  const diff = d.getTime() - Date.now();
  const abs = Math.abs(diff);
  const units: Array<[Intl.RelativeTimeFormatUnit, number]> = [
    ['year', 31_536_000_000],
    ['month', 2_592_000_000],
    ['day', 86_400_000],
    ['hour', 3_600_000],
    ['minute', 60_000],
    ['second', 1000],
  ];
  const rtf = new Intl.RelativeTimeFormat('en-IN', { numeric: 'auto' });
  for (const [unit, ms] of units) {
    if (abs >= ms || unit === 'second') {
      return rtf.format(Math.round(diff / ms), unit);
    }
  }
  return '—';
}

export function statusLabel(status: string): string {
  return STATUS_LABELS[status as OrderStatus] ?? status;
}

export function statusTone(status: string): string {
  return STATUS_TONES[status as OrderStatus] ?? 'neutral';
}

export function statusClass(status: string): string {
  return `pill pill-${statusTone(status)}`;
}

export const ALL_STATUSES = ORDER_STATUSES;

export function maskVpa(vpa: string | null | undefined): string {
  if (!vpa) return '—';
  const [user, host] = vpa.split('@');
  if (!user || !host) return '—';
  return `${user.slice(0, 2)}${'•'.repeat(Math.max(1, Math.min(6, user.length - 2)))}@${host}`;
}

export function truncate(value: string | null | undefined, length = 42): string {
  if (!value) return '—';
  return value.length > length ? `${value.slice(0, length - 1)}…` : value;
}

export function queryString(params: Record<string, string | number | undefined>): string {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== '') q.set(k, String(v));
  }
  const s = q.toString();
  return s ? `?${s}` : '';
}

export const NOTICES: Record<string, { tone: 'success' | 'error' | 'info'; text: string }> = {
  'order-created': { tone: 'success', text: 'Payment request created.' },
  'provider-updated': { tone: 'success', text: 'Provider configuration updated.' },
  'upi-verified': { tone: 'success', text: 'Merchant UPI ID verified. Direct UPI collection is now available.' },
  'upi-cleared': { tone: 'info', text: 'Merchant UPI ID removed. Direct UPI collection is disabled.' },
  'merchant-updated': { tone: 'success', text: 'Merchant status updated.' },
  'gmail-connected': { tone: 'success', text: 'Gmail connected. Only transaction alerts from allow-listed senders are read.' },
  'gmail-disconnected': { tone: 'info', text: 'Gmail disconnected and the stored token was destroyed.' },
  'review-approved': { tone: 'success', text: 'Payment approved manually. The decision is recorded in the audit log.' },
  'review-rejected': { tone: 'info', text: 'Case rejected. The order returned to its normal state.' },
  'case-assigned': { tone: 'success', text: 'Case linked to the order.' },
  'refund-created': { tone: 'success', text: 'Refund submitted to the provider.' },
  'refund-reconciled': { tone: 'success', text: 'Refund status refreshed from the provider.' },
  'password-confirmed': { tone: 'success', text: 'Sensitive actions unlocked for 10 minutes.' },
  'health-checked': { tone: 'info', text: 'Provider health checks completed.' },
  'provider-checked': { tone: 'info', text: 'Provider status re-checked. No change unless the provider confirmed it.' },
  'export-ready': { tone: 'info', text: 'Export generated.' },
  'signed-out': { tone: 'info', text: 'You have been signed out.' },
};

export const ERROR_NOTICES: Record<string, string> = {
  'csrf': 'Your session token expired. Please sign in again.',
  'step-up': 'Confirm your password to perform that action.',
  'forbidden': 'You do not have permission to perform that action.',
  'not-found': 'That record no longer exists.',
  'invalid-credentials': 'Email or password is incorrect.',
  'locked': 'Too many failed sign-in attempts. Try again later.',
  'invalid-input': 'Please correct the highlighted fields.',
  'provider-failed': 'The provider rejected the request. Nothing was changed.',
  'amount-mismatch': 'The amount does not match the order. Confirm explicitly to override.',
};

export function noticeFor(code: unknown): { tone: string; text: string } | null {
  if (typeof code !== 'string') return null;
  return NOTICES[code] ?? null;
}

export function errorFor(code: unknown): string | null {
  if (typeof code !== 'string') return null;
  return ERROR_NOTICES[code] ?? null;
}

export function initials(name: string): string {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((p) => p[0]?.toUpperCase() ?? '')
    .join('');
}
