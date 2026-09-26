// spec: packages/core/spec/core.pseudo.md ; packages/core/ts/src/policy.ts validatePolicy
import { describe, expect, it } from 'vitest';
import { resolvePolicy, validatePolicy } from '../src/policy.js';
import { PolicyValidationError } from '../src/types.js';

describe('policy validation errors', () => {
  it('resolvePolicy() with no patch returns the documented defaults', () => {
    const policy = resolvePolicy();
    expect(policy.credits.rollover).toBe('none');
    expect(policy.upgrade.mode).toBe('immediate_prorate_reset_anchor');
    expect(policy.dunning.graceDays).toBe(7);
  });

  it("credits.rollover='banked' without credits.bankCap throws PolicyValidationError", () => {
    expect(() => resolvePolicy({ credits: { rollover: 'banked' } })).toThrow(PolicyValidationError);
  });

  it("credits.rollover='banked' with credits.bankCap set is valid", () => {
    const policy = resolvePolicy({ credits: { rollover: 'banked', bankCap: 50 } });
    expect(policy.credits.bankCap).toBe(50);
  });

  it("usage.overage='bill_overage' without usage.overageUnitPriceMinor throws", () => {
    expect(() => resolvePolicy({ usage: { overage: 'bill_overage' } })).toThrow(PolicyValidationError);
  });

  it('dunning.graceDays < 0 throws', () => {
    expect(() => resolvePolicy({ dunning: { graceDays: -1 } })).toThrow(PolicyValidationError);
  });

  it('refund.noQuestionsDays < 0 throws', () => {
    expect(() => resolvePolicy({ refund: { noQuestionsDays: -1 } })).toThrow(PolicyValidationError);
  });

  it('an invalid enum value throws and names the offending path', () => {
    try {
      // @ts-expect-error deliberately invalid enum value for the test
      resolvePolicy({ upgrade: { mode: 'not_a_real_mode' } });
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(PolicyValidationError);
      expect((err as PolicyValidationError).message).toContain('upgrade.mode');
    }
  });
});

describe('policy authority boundaries', () => {
  it.each([
    ['cs.autoApprove.maxAmountMinor', -1],
    ['cs.autoApprove.maxAmountMinor', 0.5],
    ['cs.autoApprove.maxAmountMinor', null],
    ['cs.autoApprove.maxAmountMinor', Number.NaN],
    ['cs.autoApprove.maxAmountMinor', Number.POSITIVE_INFINITY],
    ['cs.autoApprove.maxAmountMinor', Number.MAX_SAFE_INTEGER + 1],
    ['cs.autoApprove.maxCredits', true],
    ['cs.fraud.windowDays', 0],
    ['cs.fraud.refundVelocity', -1],
    ['cashReceipt.cancelOnRefund', 'false'],
    ['dunning.retryIntervalHours', [0]],
    ['credits.topupExpiryDays', -1],
    ['usage.creditConversion', { unit: 'token', creditsPerUnit: -1 }],
    ['retention.auditLogDays', 0],
    ['cs.autoApprove', null],
    ['usage.creditConversion', { unit: 'token' }],
  ])('rejects invalid %s=%j', (path, value) => {
    const policy = resolvePolicy();
    const parts = path.split('.');
    let invalid: unknown = value;
    for (const part of [...parts].reverse()) invalid = { [part]: invalid };
    expect(() => validatePolicy(mergeForTest(policy, invalid))).toThrow(PolicyValidationError);
  });

  it('isolates defaults, resolved policies, and caller retry arrays', () => {
    const first = resolvePolicy();
    const second = resolvePolicy();
    expect(first.cs).not.toBe(second.cs);
    expect(first.cs.autoApprove).not.toBe(second.cs.autoApprove);
    const retries = [12];
    const configured = resolvePolicy({ dunning: { retryIntervalHours: retries } });
    retries.push(24);
    expect(configured.dunning.retryIntervalHours).toEqual([12]);
    expect(first.dunning.retryIntervalHours).not.toBe(second.dunning.retryIntervalHours);
    const third = resolvePolicy({ refund: { noQuestionsDays: 3 } });
    expect(third.cs.autoApprove).not.toBe(first.cs.autoApprove);
  });

  it('allows zero authority limits and a positive fraud window', () => {
    const policy = resolvePolicy({ cs: { autoApprove: { maxAmountMinor: 0, maxCredits: 0 }, fraud: { windowDays: 1 } } });
    expect(policy.cs.autoApprove.maxAmountMinor).toBe(0);
  });
});

function mergeForTest(base: unknown, patch: unknown): unknown {
  if (typeof base !== 'object' || base === null || typeof patch !== 'object' || patch === null || Array.isArray(patch)) return patch;
  const entries = Object.entries(base);
  return Object.fromEntries(entries.map(([key, value]) => [key,
    key in patch ? mergeForTest(value, Reflect.get(patch, key)) : value]));
}

describe('explicit configured policy rules', () => {
  it.each([
    { refnud: {} },
    { refund: { annualDaysThreshold: 10 } },
    { cs: { autoApprove: { maxAmuntMinor: 100 } } },
    { usage: { creditConversion: { unit: 'token', creditsPerUnit: 1, typo: true } } },
  ])('rejects unknown keys from configuration %j', (patch) => {
    expect(() => Reflect.apply(resolvePolicy, undefined, [patch])).toThrow(PolicyValidationError);
  });

  it('requires the annual refund denial threshold', () => {
    expect(() => resolvePolicy({ refund: { annualMethod: 'deny_after_days' } })).toThrow(PolicyValidationError);
    expect(resolvePolicy({ refund: { annualMethod: 'deny_after_days', annualDenyAfterDays: 0 } }).refund.annualDenyAfterDays).toBe(0);
  });
});
