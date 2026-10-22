/**
 * UPI QR payload generation (NPCI "UPI Linking Specification" / BHIM format).
 *
 * This module only *renders* a payload. It does not prove anything about the
 * payment: a scanned QR carries no payment confirmation. Treat the payload as
 * a piece of display data and never as evidence.
 */

export type UpiQrParams = {
  payeeVpa: string;
  payeeName: string;
  amountPaise: number | null; // null => open-amount static QR (avoid for orders)
  transactionNote?: string;
  transactionRef?: string;
  merchantCode?: string;
};

const VPA_RE = /^[a-zA-Z0-9.\-_]{2,60}@[a-zA-Z][a-zA-Z0-9.\-]{1,40}$/;

export function isValidVpa(vpa: string): boolean {
  return VPA_RE.test(vpa);
}

/**
 * Escapes characters reserved by the UPI payload spec. UPI uses a restricted
 * "iw" syntax where ':' '%' and others must be percent-encoded, and payload
 * fields must not contain the separator characters.
 */
function escapeField(value: string): string {
  return encodeURIComponent(value.replace(/[|&:]/g, ' ')).replace(/%20/g, '%20');
}

export function buildUpiUri(params: UpiQrParams): string {
  if (!isValidVpa(params.payeeVpa)) throw new Error('Invalid payee VPA');
  if (params.payeeName.trim().length === 0) throw new Error('Payee name required');
  if (params.payeeName.length > 50) throw new Error('Payee name too long');
  if (params.amountPaise !== null) {
    if (!Number.isSafeInteger(params.amountPaise) || params.amountPaise < 100) {
      throw new Error('UPI QR amounts must be integer paise, minimum ₹1.00');
    }
  }
  const parts = [
    `pa=${encodeURIComponent(params.payeeVpa)}`,
    `pn=${escapeField(params.payeeName)}`,
    `cu=INR`,
  ];
  if (params.amountPaise !== null) {
    // UPI spec expects rupees with two decimals.
    const rupees = (params.amountPaise / 100).toFixed(2);
    parts.push(`am=${rupees}`);
  }
  if (params.transactionRef) {
    // tr is limited to 35 alphanumeric characters per NPCI spec.
    const ref = params.transactionRef.replace(/[^A-Za-z0-9]/g, '').slice(0, 35);
    if (ref.length > 0) parts.push(`tr=${ref}`);
  }
  if (params.transactionNote) {
    parts.push(`tn=${escapeField(params.transactionNote.slice(0, 50))}`);
  }
  if (params.merchantCode) {
    // mc is the 4-digit merchant category code; only send numeric codes.
    const mc = params.merchantCode.replace(/\D/g, '').slice(0, 4);
    if (mc.length === 4) parts.push(`mc=${mc}`);
  }
  return `upi://pay?${parts.join('&')}`;
}

export type ParsedUpiUri = {
  payeeVpa: string | null;
  payeeName: string | null;
  amountPaise: number | null;
  transactionRef: string | null;
  note: string | null;
  currency: string | null;
};

/** Parses a UPI intent URI (used by tests and by refund review tooling). */
export function parseUpiUri(uri: string): ParsedUpiUri {
  const [, query = ''] = uri.split('?');
  const q = new URLSearchParams(query);
  const am = q.get('am');
  let amountPaise: number | null = null;
  if (am && /^\d+(\.\d{1,2})?$/.test(am)) {
    const [r, p = ''] = am.split('.');
    amountPaise = Number(r) * 100 + Number(p.padEnd(2, '0') || '0');
  }
  return {
    payeeVpa: q.get('pa'),
    payeeName: q.get('pn'),
    amountPaise,
    transactionRef: q.get('tr'),
    note: q.get('tn'),
    currency: q.get('cu'),
  };
}
