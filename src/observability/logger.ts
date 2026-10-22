/**
 * Minimal structured logger with name-based secret redaction.
 *
 * Rationale: payment platforms leak credentials through logs far more often
 * than through APIs. Every log line passes through `redact()` which replaces
 * values whose key looks sensitive and scrubs known token shapes.
 */

const SENSITIVE_KEY =
  /(secret|token|password|passwd|authorization|api[_-]?key|client[_-]?secret|refresh|credential|cookie|signature|private[_-]?key)/i;

const VALUE_PATTERNS: Array<[RegExp, string]> = [
  [/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g, '[redacted-jwt]'],
  [/\b\d{12}:[A-Za-z0-9_-]{20,}\b/g, '[redacted-bot-token]'],
  [/\b1\/\/[A-Za-z0-9_-]{20,}\b/g, '[redacted-google-refresh-token]'],
  [/\bya29\.[A-Za-z0-9_-]{20,}\b/g, '[redacted-google-access-token]'],
  [/\b(?:rzp|cf)_(?:test|live)_[A-Za-z0-9]{8,}\b/g, '[redacted-provider-key]'],
];

export function redactString(input: string): string {
  let out = input;
  for (const [re, replacement] of VALUE_PATTERNS) out = out.replace(re, replacement);
  return out;
}

export function redact(value: unknown, depth = 0): unknown {
  if (depth > 6) return '[depth-limit]';
  if (value === null || value === undefined) return value;
  if (typeof value === 'string') return redactString(value);
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (value instanceof Error) {
    return { name: value.name, message: redactString(value.message) };
  }
  if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1));
  if (typeof value === 'object') {
    const src = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(src)) {
      out[k] = SENSITIVE_KEY.test(k) ? '[redacted]' : redact(v, depth + 1);
    }
    return out;
  }
  return String(value);
}

type Level = 'debug' | 'info' | 'warn' | 'error';

const LEVEL_ORDER: Record<Level | 'silent', number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
  silent: 100,
};

export interface Logger {
  debug(msg: string, meta?: Record<string, unknown>): void;
  info(msg: string, meta?: Record<string, unknown>): void;
  warn(msg: string, meta?: Record<string, unknown>): void;
  error(msg: string, meta?: Record<string, unknown>): void;
  child(bindings: Record<string, unknown>): Logger;
}

export function createLogger(
  level: Level | 'silent' = 'info',
  bindings: Record<string, unknown> = {},
  sink: (line: string) => void = (line) => process.stdout.write(line + '\n'),
): Logger {
  const min = LEVEL_ORDER[level];
  const emit = (lvl: Level, msg: string, meta?: Record<string, unknown>) => {
    if (LEVEL_ORDER[lvl] < min) return;
    const record = {
      ts: new Date().toISOString(),
      level: lvl,
      msg: redactString(msg),
      ...(redact(bindings) as Record<string, unknown>),
      ...(meta ? (redact(meta) as Record<string, unknown>) : {}),
    };
    sink(JSON.stringify(record));
  };
  return {
    debug: (m, meta) => emit('debug', m, meta),
    info: (m, meta) => emit('info', m, meta),
    warn: (m, meta) => emit('warn', m, meta),
    error: (m, meta) => emit('error', m, meta),
    child: (b) => createLogger(level, { ...bindings, ...b }, sink),
  };
}

let root: Logger | null = null;

export function getLogger(): Logger {
  if (!root) {
    const level = (process.env.LOG_LEVEL as Level) || 'info';
    root = createLogger(level);
  }
  return root;
}

export function setLogger(logger: Logger): void {
  root = logger;
}
