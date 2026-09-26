// Regression tests for redact() / Logger implementations.
// spec: packages/core/spec/core.pseudo.md [EC:L1] [EC:L2] [EC:L5], docs/EDGE_CASES.md §L.
import { describe, expect, it } from 'vitest';
import { redact, NoopLogger, ConsoleLogger, CollectingLogger, BaseLogger } from '../src/logger.js';
import type { LogEntry } from '../src/types.js';

describe('redact()', () => {
  // EC:L2 — a payload containing a 주민등록번호 and a card PAN comes out scrubbed.
  it('redacts a 주민등록번호 (customerIdentityNumber) to [redacted]', () => {
    const out = redact({ customerIdentityNumber: '900101-1234567', ok: 'fine' }) as Record<string, unknown>;
    expect(out.customerIdentityNumber).toBe('[redacted]');
    expect(out.ok).toBe('fine');
  });

  it('masks a card PAN keeping first 6 / last 4, wherever the value appears', () => {
    const out = redact({ cardNumber: '4906251234123456' }) as Record<string, unknown>;
    expect(out.cardNumber).toBe('[redacted]'); // sensitive-key redaction wins over PAN masking
    const nested = redact({ raw: { some_other_field: '4906 2512 3412 3456' } }) as { raw: Record<string, unknown> };
    expect(nested.raw.some_other_field).toBe('490625******3456');
  });

  it('masks billingKey (first4/last4) instead of dropping it — CS needs to correlate by it', () => {
    const out = redact({ billingKey: 'bk_abcdefgh12345678' }) as Record<string, unknown>;
    expect(out.billingKey).toBe('bk_a***********5678');
    expect(out.billingKey).not.toBe('bk_abcdefgh12345678');
  });

  it('redacts snake_case and differently-cased key spellings the same as camelCase', () => {
    const out = redact({ customer_identity_number: '900101-1234567', SECRET_KEY: 'sk_live_xxx', Authorization: 'Bearer xxx' }) as Record<string, unknown>;
    expect(out.customer_identity_number).toBe('[redacted]');
    expect(out.SECRET_KEY).toBe('[redacted]');
    expect(out.Authorization).toBe('[redacted]');
  });

  it('recurses into nested objects and arrays', () => {
    const out = redact({ items: [{ cardPassword: '12' }, { apiKey: 'k' }] }) as { items: Record<string, unknown>[] };
    expect(out.items[0].cardPassword).toBe('[redacted]');
    expect(out.items[1].apiKey).toBe('[redacted]');
  });

  it('leaves non-sensitive fields, Dates, numbers and booleans untouched', () => {
    const date = new Date('2026-09-09T00:00:00Z');
    const out = redact({ amount: 1000, active: true, at: date, event: 'provider.request' }) as Record<string, unknown>;
    expect(out.amount).toBe(1000);
    expect(out.active).toBe(true);
    expect((out.at as Date).getTime()).toBe(date.getTime());
    expect(out.event).toBe('provider.request');
  });

  it('the whole payload — 주민번호 + PAN together — comes out scrubbed in one pass', () => {
    const payload = {
      cardNumber: '4906251234123456',
      customerIdentityNumber: '900101-1234567',
      customerName: 'ok to keep',
    };
    const out = redact(payload) as Record<string, unknown>;
    expect(out).toEqual({
      cardNumber: '[redacted]',
      customerIdentityNumber: '[redacted]',
      customerName: 'ok to keep',
    });
  });
});

describe('NoopLogger', () => {
  it('does nothing and never throws', async () => {
    await expect(new NoopLogger().log({ level: 'error', event: 'x', secretKey: 'leak-if-broken' })).resolves.toBeUndefined();
  });
});

describe('CollectingLogger / BaseLogger', () => {
  it('log() redacts before the entry ever reaches write() — impossible to forget at a call site', async () => {
    const logger = new CollectingLogger();
    await logger.log({ level: 'info', event: 'provider.request', cardNumber: '4906251234123456', ok: 1 });
    expect(logger.entries).toHaveLength(1);
    expect(logger.entries[0].cardNumber).toBe('[redacted]');
    expect(logger.entries[0].ok).toBe(1);
    expect(logger.entries[0].at).toBeInstanceOf(Date);
  });

  it('preserves a caller-supplied `at` instead of overwriting it', async () => {
    const logger = new CollectingLogger();
    const at = new Date('2020-01-01T00:00:00Z');
    await logger.log({ level: 'info', event: 'x', at });
    expect(logger.entries[0].at.getTime()).toBe(at.getTime());
  });

  it('a subclass cannot bypass redaction: write() only ever sees the post-redact entry', async () => {
    let seen: LogEntry | undefined;
    class Spy extends BaseLogger {
      protected write(entry: LogEntry & { at: Date }): void {
        seen = entry;
      }
    }
    await new Spy().log({ level: 'warn', event: 'x', apiSecret: 'super-secret' });
    expect(seen?.apiSecret).toBe('[redacted]');
  });
});

describe('ConsoleLogger', () => {
  it('routes warn/error to console.error/console.warn, info/debug to console.log — and redacts', () => {
    const calls: { fn: string; line: string }[] = [];
    const orig = { log: console.log, warn: console.warn, error: console.error };
    console.log = (line: string) => calls.push({ fn: 'log', line });
    console.warn = (line: string) => calls.push({ fn: 'warn', line });
    console.error = (line: string) => calls.push({ fn: 'error', line });
    try {
      const logger = new ConsoleLogger();
      void logger.log({ level: 'info', event: 'a' });
      void logger.log({ level: 'warn', event: 'b' });
      void logger.log({ level: 'error', event: 'c', secretKey: 'leak-if-broken' });
    } finally {
      console.log = orig.log;
      console.warn = orig.warn;
      console.error = orig.error;
    }
    // Promise.resolve() microtask ordering: log() is synchronous-ish for ConsoleLogger (no await
    // inside write()), but log() itself is async — flush isn't needed here because ConsoleLogger's
    // write() runs synchronously inside the (non-awaited) async log() before the first await point,
    // since there is no await before calling write(). Assert eventually via microtask flush.
    return Promise.resolve().then(() => {
      expect(calls.some((c) => c.fn === 'log' && c.line.includes('"event":"a"'))).toBe(true);
      expect(calls.some((c) => c.fn === 'warn' && c.line.includes('"event":"b"'))).toBe(true);
      const errorCall = calls.find((c) => c.fn === 'error');
      expect(errorCall?.line.includes('leak-if-broken')).toBe(false);
      expect(errorCall?.line.includes('[redacted]')).toBe(true);
    });
  });
});
