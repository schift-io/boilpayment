/**
 * EC:L1 L2 — Logger DI + redaction. Mirrors packages/core/py/src/schift_payment_kit_core/logger.py
 * exactly. See docs/EDGE_CASES.md §L.
 *
 * Design: `redact()` runs INSIDE `BaseLogger.log()`, not at call sites — a call site can pass a
 * raw provider request/response body and every real (non-Noop) Logger implementation scrubs it
 * before it ever reaches console/DB/anywhere else. `NoopLogger` is the default so the kit stays
 * silent unless an app opts in (see packages/core/ts/src/types.ts `Deps.logger?`).
 */
import { LogEntry, Logger } from './types.js';

// ── Redaction ─────────────────────────────────────────────────────────────────

// EC:L2 — normalized (lower-cased, separators stripped) key names that never leave this process
// in the clear. `billingKey`/`billing_key` is MASKED, not dropped — CS needs to correlate charges
// by billing key, it just never needs the raw value in a log line.
const REDACT_KEYS = new Set([
  'customeridentitynumber', // 주민등록번호 / 사업자등록번호
  'cardnumber',
  'cardpassword',
  'customerbirthday',
  'secretkey',
  'apikey',
  'apisecret',
  'accesstoken',
  'authorization',
  'webhooksecret',
  'refundreceiveaccount',
]);
const MASK_KEYS = new Set(['billingkey']);

function normalizeKey(key: string): string {
  return key.toLowerCase().replace(/[_-]/g, '');
}

/** Keeps first 4 / last 4 chars, masks the middle. Falls back to full redaction for short values. */
function maskGeneric(value: string): string {
  if (value.length <= 8) return '[redacted]';
  return `${value.slice(0, 4)}${'*'.repeat(Math.max(4, value.length - 8))}${value.slice(-4)}`;
}

// EC:L2 — card PAN: 13-19 digits, optionally grouped with spaces/dashes, wherever it appears in
// ANY string value (not just under a `cardNumber`-named key — e.g. inside a raw provider payload
// under a differently-named field). Keeps first 6 / last 4 per the brief; masks the rest with `*`.
const PAN_RE = /\b\d(?:[ -]?\d){12,18}\b/g;

function maskPansInString(value: string): string {
  return value.replace(PAN_RE, (match) => {
    const digits = match.replace(/[ -]/g, '');
    if (digits.length < 13 || digits.length > 19) return match;
    const first6 = digits.slice(0, 6);
    const last4 = digits.slice(-4);
    return `${first6}${'*'.repeat(digits.length - 10)}${last4}`;
  });
}

/**
 * EC:L2 — deep-clones `value`, replacing values under sensitive keys with `'[redacted]'` (or a
 * partial mask for keys in MASK_KEYS) and masking any string that looks like a card PAN. Safe to
 * call on arbitrary provider payloads, webhook bodies, or ledger fields.
 */
export function redact(value: unknown): unknown {
  if (value === null || value === undefined) return value;
  if (value instanceof Date) return new Date(value.getTime());
  if (Array.isArray(value)) return value.map(redact);
  if (typeof value === 'string') return maskPansInString(value);
  if (typeof value !== 'object') return value; // number, boolean, bigint, etc.

  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    const nk = normalizeKey(k);
    if (REDACT_KEYS.has(nk)) {
      out[k] = '[redacted]';
    } else if (MASK_KEYS.has(nk)) {
      out[k] = typeof v === 'string' ? maskGeneric(v) : '[redacted]';
    } else {
      out[k] = redact(v);
    }
  }
  return out;
}

// ── Logger implementations ──────────────────────────────────────────────────

/** Default — the kit stays silent unless an app opts into a real Logger. Deliberately skips redact(). */
export class NoopLogger implements Logger {
  async log(_entry: LogEntry): Promise<void> {
    // no-op
  }
}

/**
 * EC:L1 — every concrete Logger extends this so redaction happens exactly once, in one place, and
 * can't be forgotten at a call site. Subclasses implement `write()` with the already-redacted entry.
 */
export abstract class BaseLogger implements Logger {
  async log(entry: LogEntry): Promise<void> {
    const redacted = redact(entry) as LogEntry;
    redacted.at = entry.at ?? new Date();
    await this.write(redacted as LogEntry & { at: Date });
  }

  protected abstract write(entry: LogEntry & { at: Date }): Promise<void> | void;
}

export class ConsoleLogger extends BaseLogger {
  protected write(entry: LogEntry & { at: Date }): void {
    const { level } = entry;
    const line = JSON.stringify(entry);
    if (level === 'error') console.error(line);
    else if (level === 'warn') console.warn(line);
    else console.log(line);
  }
}

/** For tests — collects every redacted entry in order instead of emitting anywhere. */
export class CollectingLogger extends BaseLogger {
  readonly entries: (LogEntry & { at: Date })[] = [];

  protected write(entry: LogEntry & { at: Date }): void {
    this.entries.push(entry);
  }
}
