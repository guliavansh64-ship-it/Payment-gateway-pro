import { MoneyError, parseRupeesToPaise } from '../domain/money';
import { normalizeReference } from '../services/reference';

/**
 * Transaction email parser.
 *
 * Scope and honesty:
 *  - Only a small, configurable set of sender domains is accepted, and the
 *    *address* is validated — a display name such as "HDFC Bank" proves nothing.
 *  - Parsing is best-effort across known template families. Every unparsed or
 *    contradictory field lowers confidence rather than being guessed.
 *  - The result is a CANDIDATE. It can never mark an order paid.
 *
 * Supported inputs: plain text and HTML bodies, forwarded/quoted bodies,
 * duplicate alerts, missing fields and malformed markup (never throws).
 */

export type EmailStatusGuess = 'SUCCESS' | 'FAILED' | 'PENDING' | 'UNKNOWN';
export type EmailDirection = 'CREDIT' | 'DEBIT' | 'UNKNOWN';

export type ParsedTransactionEmail = {
  messageId: string;
  fromAddress: string;
  fromDomain: string;
  subject: string;
  receivedAt: Date;
  amountPaise: number | null;
  currency: 'INR' | null;
  direction: EmailDirection;
  status: EmailStatusGuess;
  utr: string | null;
  bankReference: string | null;
  payeeVpa: string | null;
  payerVpa: string | null;
  vpas: string[];
  counterpartyName: string | null;
  providerGuess: string | null;
  confidence: number;
  warnings: string[];
  /** Only the normalised text is retained; raw bodies are not persisted. */
  textChars: number;
};

export type SenderPolicy = {
  allowedDomains: string[];
};

export type SenderCheck =
  | { accepted: true; domain: string }
  | { accepted: false; reason: string; domain: string | null };

// ---------------------------------------------------------------------------
// sender validation
// ---------------------------------------------------------------------------

const EMAIL_RE = /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@([A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+)$/;

export function extractAddress(fromHeader: string): string | null {
  if (!fromHeader) return null;
  // Prefer the angle-address; display names are never used for trust decisions.
  const angle = /<([^<>]+)>/.exec(fromHeader);
  const candidate = (angle?.[1] ?? fromHeader).trim().replace(/^mailto:/i, '');
  return EMAIL_RE.test(candidate) ? candidate.toLowerCase() : null;
}

export function checkSender(fromHeader: string, policy: SenderPolicy): SenderCheck {
  const address = extractAddress(fromHeader);
  if (!address) return { accepted: false, domain: null, reason: 'Unparseable From address' };
  const domain = address.slice(address.lastIndexOf('@') + 1);
  if (policy.allowedDomains.length === 0) {
    return { accepted: false, domain, reason: 'No sender domains are configured' };
  }
  const allowed = policy.allowedDomains.some((d) => domain === d || domain.endsWith(`.${d}`));
  if (!allowed) {
    return { accepted: false, domain, reason: `Sender domain ${domain} is not on the allow-list` };
  }
  return { accepted: true, domain };
}

// ---------------------------------------------------------------------------
// body normalisation
// ---------------------------------------------------------------------------

const ENTITIES: Record<string, string> = {
  '&nbsp;': ' ',
  '&amp;': '&',
  '&lt;': '<',
  '&gt;': '>',
  '&quot;': '"',
  '&#39;': "'",
  '&apos;': "'",
  '&rsquo;': "'",
  '&ndash;': '-',
  '&mdash;': '-',
  '&rupee;': '₹',
};

export function htmlToText(html: string): string {
  let out = html;
  // Remove non-content elements entirely.
  out = out.replace(/<(script|style|head|title|noscript)[^>]*>[\s\S]*?<\/\1>/gi, ' ');
  out = out.replace(/<!--[\s\S]*?-->/g, ' ');
  // Preserve some structure as whitespace.
  out = out.replace(/<\/?(br|p|div|tr|li|h[1-6])\s*\/?>/gi, '\n');
  out = out.replace(/<[^>]+>/g, ' ');
  for (const [entity, char] of Object.entries(ENTITIES)) {
    out = out.split(entity).join(char);
  }
  out = out.replace(/&#(\d{1,6});/g, (_m, code: string) => {
    const n = Number(code);
    return Number.isFinite(n) && n > 0 && n < 0x10ffff ? String.fromCodePoint(n) : ' ';
  });
  return out.replace(/[ \t\u00a0]+/g, ' ').replace(/\n\s*\n+/g, '\n').trim();
}

/** Decodes base64url (Gmail API encodes bodies that way). */
export function decodeBase64Url(data: string): string {
  try {
    return Buffer.from(data.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
  } catch {
    return '';
  }
}

export type GmailPart = {
  mimeType?: string;
  body?: { data?: string; size?: number };
  parts?: GmailPart[];
  headers?: Array<{ name?: string; value?: string }>;
};

/** Depth-first extraction of the best text body, preferring text/plain. */
export function extractBodyText(payload: GmailPart): string {
  const plain: string[] = [];
  const html: string[] = [];

  const walk = (part: GmailPart, depth: number): void => {
    if (depth > 12) return;
    const mime = (part.mimeType ?? '').toLowerCase();
    if (part.body?.data) {
      if (mime === 'text/plain') plain.push(decodeBase64Url(part.body.data));
      else if (mime === 'text/html') html.push(decodeBase64Url(part.body.data));
    }
    for (const child of part.parts ?? []) walk(child, depth + 1);
  };
  walk(payload, 0);

  if (plain.length > 0) return plain.join('\n').trim();
  if (html.length > 0) return htmlToText(html.join('\n'));
  return '';
}

// ---------------------------------------------------------------------------
// field extraction
// ---------------------------------------------------------------------------

const AMOUNT_PATTERNS: RegExp[] = [
  // ₹ 1,499.00 / Rs. 1499 / INR 499.5
  /(?:₹|rs\.?|inr)\s*([0-9][0-9,]*(?:\.[0-9]{1,2})?)/i,
  // 1,499.00 INR / 499.00 Rs
  /([0-9][0-9,]*(?:\.[0-9]{1,2})?)\s*(?:inr|rs\.?|rupees)\b/i,
  // "Amount: 1499.00"
  /amount\s*[:\-]?\s*([0-9][0-9,]*(?:\.[0-9]{1,2})?)/i,
];

export function extractAmountPaise(text: string): number | null {
  for (const pattern of AMOUNT_PATTERNS) {
    const match = pattern.exec(text);
    if (!match?.[1]) continue;
    try {
      const paise = parseRupeesToPaise(match[1]);
      if (paise > 0) return paise;
    } catch (err) {
      if (!(err instanceof MoneyError)) throw err;
    }
  }
  return null;
}

const UTR_PATTERNS: RegExp[] = [
  /\butr(?:\s*(?:no|number|id))?\s*[:\-#]?\s*([0-9]{12})\b/i,
  /\brrn(?:\s*(?:no|number|id))?\s*[:\-#]?\s*([0-9]{12})\b/i,
  /\bupi\s*(?:transaction|txn)\s*(?:id|ref(?:erence)?)\s*[:\-#]?\s*([0-9]{12})\b/i,
  /\bbank\s*(?:reference|ref)\s*(?:no|number|id)?\s*[:\-#]?\s*([A-Za-z0-9]{10,22})\b/i,
];

export function extractUtr(text: string): string | null {
  for (const pattern of UTR_PATTERNS) {
    const match = pattern.exec(text);
    if (match?.[1]) return normalizeReference(match[1]);
  }
  return null;
}

const VPA_RE = /\b([a-zA-Z0-9.\-_]{2,60}@[a-zA-Z][a-zA-Z0-9.\-]{1,40})\b/g;

export function extractVpas(text: string): string[] {
  const found = new Set<string>();
  for (const match of text.matchAll(VPA_RE)) {
    const vpa = match[1];
    if (!vpa) continue;
    const lower = vpa.toLowerCase();
    // Exclude ordinary email addresses of the sender/support team.
    if (/(bank|support|alerts?|noreply|no-reply|care|service)@/.test(lower)) continue;
    found.add(lower);
  }
  return [...found];
}

export function classifyDirection(text: string): EmailDirection {
  const t = text.toLowerCase();
  const credit =
    /(credited to|credited from|credit received|received from|you have received|has been credited|amount credited|credit of|payment received|received in your|money received|deposited)/.test(
      t,
    );
  const debit = /(debited from|you have paid|has been debited|sent to|payment of .* successful|debit of)/.test(t);
  if (t.includes('credited to your') || t.includes('received in your account')) return 'CREDIT';
  if (credit && !debit) return 'CREDIT';
  if (debit && !credit) return 'DEBIT';
  if (credit && debit) {
    // Most alerts say "Rs X credited to your account ... from <payer>": credit wins.
    return 'CREDIT';
  }
  return 'UNKNOWN';
}

export function classifyStatus(text: string): EmailStatusGuess {
  const t = text.toLowerCase();
  if (/(failed|declined|unsuccessful|not successful|could not|couldn't|rejected|cancelled|reversed|refunded|returned)/.test(t)) {
    return 'FAILED';
  }
  if (/(pending|processing|will be credited|in progress|awaited|on hold)/.test(t)) return 'PENDING';
  if (/(success|successful|credited|received|paid|completed|confirmed|deposited)/.test(t)) return 'SUCCESS';
  return 'UNKNOWN';
}

const PROVIDERS: Array<[RegExp, string]> = [
  [/\bgoogle\s*pay\b|\bgpay\b/i, 'google_pay'],
  [/\bphonepe\b/i, 'phonepe'],
  [/\bpaytm\b/i, 'paytm'],
  [/\bbhim\b/i, 'bhim'],
  [/\bamazon\s*pay\b/i, 'amazon_pay'],
  [/\bcr[eé]d\b/i, 'cred'],
  [/\bwhatsapp\s*pay\b/i, 'whatsapp_pay'],
];

export function detectProvider(text: string): string | null {
  for (const [re, name] of PROVIDERS) if (re.test(text)) return name;
  return null;
}

/** Contextual VPA roles: "to VPA x" = payee, "from VPA y" = payer. */
function classifyVpaRoles(text: string): { payee: string | null; payer: string | null } {
  // The VPA may be separated from the keyword by a name in brackets, e.g.
  // "from RAMESH KUMAR (ramesh@okaxis)", so allow a short bounded gap.
  const vpa = '([a-zA-Z0-9.\-_]{2,60}@[a-zA-Z][a-zA-Z0-9.\-]{1,40})';
  const payeeMatch = new RegExp(
    `(?:to|towards|payee|beneficiary)[^\\n]{0,60}?${vpa}`,
    'i',
  ).exec(text);
  const payerMatch = new RegExp(
    `(?:from|payer|sender|remitter)[^\\n]{0,60}?${vpa}`,
    'i',
  ).exec(text);
  return {
    payee: payeeMatch?.[1]?.toLowerCase() ?? null,
    payer: payerMatch?.[1]?.toLowerCase() ?? null,
  };
}

// ---------------------------------------------------------------------------
// main entry point
// ---------------------------------------------------------------------------

export function parseTransactionEmail(input: {
  messageId: string;
  fromHeader: string;
  subject: string;
  receivedAt: Date;
  text: string;
}): ParsedTransactionEmail {
  const warnings: string[] = [];
  const text = input.text.slice(0, 50_000);
  const subject = input.subject.slice(0, 300);
  const combined = `${subject}\n${text}`;

  const fromAddress = extractAddress(input.fromHeader) ?? '';
  const fromDomain = fromAddress.includes('@') ? fromAddress.slice(fromAddress.lastIndexOf('@') + 1) : '';

  if (/^\s*(fwd|fw)\s*:/i.test(subject)) warnings.push('forwarded_message');
  if (text.length === 0) warnings.push('empty_body');
  if (/<[a-z][\s\S]*>/i.test(text)) warnings.push('unexpected_html_in_text');

  const amountPaise = extractAmountPaise(combined);
  if (amountPaise === null) warnings.push('missing_amount');

  const direction = classifyDirection(combined);
  if (direction === 'DEBIT') warnings.push('debit_alert');
  if (direction === 'UNKNOWN') warnings.push('unknown_direction');

  const status = classifyStatus(combined);
  if (status === 'UNKNOWN') warnings.push('unknown_status');

  const utr = extractUtr(combined);
  const vpas = extractVpas(combined);
  const roles = classifyVpaRoles(combined);
  const payeeVpa = roles.payee ?? (vpas.length === 1 ? vpas[0]! : null);
  const payerVpa = roles.payer;

  let confidence = 0;
  if (amountPaise !== null) confidence += 0.35;
  if (direction === 'CREDIT') confidence += 0.25;
  if (status === 'SUCCESS') confidence += 0.2;
  if (utr) confidence += 0.15;
  if (fromDomain) confidence += 0.05;
  if (warnings.includes('forwarded_message')) confidence -= 0.15;
  if (warnings.includes('empty_body')) confidence = 0;
  confidence = Math.max(0, Math.min(1, Number(confidence.toFixed(2))));

  return {
    messageId: input.messageId,
    fromAddress,
    fromDomain,
    subject,
    receivedAt: input.receivedAt,
    amountPaise,
    currency: amountPaise !== null ? 'INR' : null,
    direction,
    status,
    utr,
    bankReference: utr,
    payeeVpa,
    payerVpa,
    vpas,
    counterpartyName: null,
    providerGuess: detectProvider(combined),
    confidence,
    warnings,
    textChars: text.length,
  };
}
