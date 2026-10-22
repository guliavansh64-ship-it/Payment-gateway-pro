/**
 * Normalises provider/bank transaction references for storage and matching.
 *
 * UTR/RRN values are numeric strings; provider ids may include dashes. The same
 * payment can appear as "UTR: 4123 4567 8901", "412345678901" and
 * "412345678901 " across sources, so normalisation happens once, here, before
 * anything is stored or compared.
 */
export function normalizeReference(raw: string | null | undefined): string | null {
  if (!raw) return null;
  let value = raw.trim();
  if (value.length === 0) return null;
  // Strip common labels: "UTR: 123", "RRN#123", "Ref - 123"
  value = value.replace(/^(utr|rrn|ref|reference|txn|transaction|upi)\s*[:#\-]?\s*/i, '');
  // Remove internal whitespace and common separators.
  value = value.replace(/[\s]+/g, '').replace(/[^A-Za-z0-9\-_.]/g, '');
  value = value.toUpperCase();
  if (value.length < 4 || value.length > 64) return null;
  return value;
}

/** True when a value looks like a 12-digit UPI UTR / RRN. */
export function looksLikeUtr(value: string): boolean {
  return /^\d{12}$/.test(value);
}
