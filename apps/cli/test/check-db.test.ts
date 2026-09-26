import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { buildConfig, samplePlan } from './helpers.js';
import type { PaykitConfig } from '../src/config.js';

// The loader is mocked so these tests describe the CONTRACT between `check` and the schema module
// (what it asks, and what it concludes from the answer) without needing a live Postgres. The live
// paths are exercised for real against a throwaway database; see docs/RELEASE.md.
const schemaStatus = vi.fn();
vi.mock('../src/util/schema-postgres.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/util/schema-postgres.js')>();
  return {
    ...actual,
    loadSchemaPostgres: vi.fn(async () => ({ migrate: vi.fn(), schemaStatus })),
  };
});

const { checkDatabase } = await import('../src/commands/check.js');

function config(overrides: Record<string, unknown> = {}): PaykitConfig {
  const c = buildConfig({ providers: ['stripe'], ...overrides }) as unknown as PaykitConfig;
  c.plans = [samplePlan()];
  return c;
}

const savedUrl = process.env.DATABASE_URL;
beforeEach(() => {
  schemaStatus.mockReset();
  process.env.DATABASE_URL = 'postgres:///unit_test_never_connected';
});
afterEach(() => {
  if (savedUrl === undefined) delete process.env.DATABASE_URL;
  else process.env.DATABASE_URL = savedUrl;
});

function status(over: Partial<{ expected: string[]; applied: string[]; pending: string[]; unknown: string[] }> = {}) {
  const s = { expected: ['0001_core.sql'], applied: ['0001_core.sql'], pending: [], unknown: [], ...over };
  return { ...s, ok: s.pending.length === 0 && s.unknown.length === 0 };
}

describe('checkDatabase', () => {
  it('a database behind this build fails the check — not just a listing of what IS applied', async () => {
    // The regression this file exists for: `check` used to read the paykit_migrations rows and
    // print them, which can only ever describe the past. It reported a clean, green, exit-0 result
    // for a database that `boilpayment migrate --dry-run` said was three migrations behind.
    schemaStatus.mockResolvedValue(
      status({ expected: ['0001_core.sql', '0002_credits.sql'], pending: ['0002_credits.sql'] }),
    );
    const report = await checkDatabase('/nonexistent', config());
    expect(report.ok).toBe(false);
    const text = report.lines.join('\n');
    expect(text).toContain('0002_credits.sql');
    expect(text).toContain('boilpayment migrate');
  });

  it('a database ahead of this build fails the check and does NOT suggest migrating', async () => {
    schemaStatus.mockResolvedValue(status({ applied: ['0001_core.sql', '0099_future.sql'], unknown: ['0099_future.sql'] }));
    const report = await checkDatabase('/nonexistent', config());
    expect(report.ok).toBe(false);
    const text = report.lines.join('\n');
    expect(text).toContain('0099_future.sql');
    expect(text).toContain('패키지 버전을 올리세요');
  });

  it('a matching schema passes', async () => {
    schemaStatus.mockResolvedValue(status());
    const report = await checkDatabase('/nonexistent', config());
    expect(report.ok).toBe(true);
    expect(report.lines.join('\n')).toContain('일치');
  });

  it('a connection failure is a failure, not a skip', async () => {
    schemaStatus.mockRejectedValue(new Error('database "nope" does not exist'));
    const report = await checkDatabase('/nonexistent', config());
    expect(report.ok).toBe(false);
    expect(report.lines.join('\n')).toContain('DB 연결 실패');
  });

  it('no DATABASE_URL anywhere is a skip, not a failure', async () => {
    delete process.env.DATABASE_URL;
    const report = await checkDatabase('/nonexistent', config());
    expect(report.ok).toBe(true);
    expect(schemaStatus).not.toHaveBeenCalled();
    expect(report.lines.join('\n')).toContain('skip');
  });

  it('asks about exactly the modules this config generated migrations for', async () => {
    schemaStatus.mockResolvedValue(status());
    await checkDatabase('/nonexistent', config({ goods: ['credits'], models: ['subscription'], cs_enabled: false }));
    expect(schemaStatus.mock.calls[0][0].modules).toEqual(['core', 'webhook', 'refund', 'credits', 'cs']);
  });
});
