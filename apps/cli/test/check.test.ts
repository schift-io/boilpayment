import { describe, it, expect } from 'vitest';
import { computeWarnings } from '../src/commands/check.js';
import { buildConfig, samplePlan } from './helpers.js';

// Baseline answers that trigger NONE of computeWarnings' codes, so each test below can flip
// exactly one thing and see exactly one warning appear.
function cleanConfig(overridesById: Record<string, unknown> = {}) {
  const config = buildConfig({ providers: ['stripe'], infra_notify_slack: true, ...overridesById });
  config.plans = [samplePlan()];
  return config;
}

describe('computeWarnings', () => {
  it('a clean config (single non-toss provider, a notify channel, a plan) has zero warnings', () => {
    expect(computeWarnings(cleanConfig(), {})).toEqual([]);
  });

  it('CS_API_KEY: cs enabled but PAYKIT_API_KEY not in env', () => {
    const config = cleanConfig({ cs_enabled: true });
    expect(computeWarnings(config, {}).map((w) => w.code)).toContain('CS_API_KEY');
    expect(computeWarnings(config, { PAYKIT_API_KEY: 'pk_live_x' }).map((w) => w.code)).not.toContain('CS_API_KEY');
  });

  it('B1: credits.rollover=banked with bankCap cleared to null', () => {
    const config = cleanConfig({ credits_rollover: 'banked' });
    config.policy.credits.bankCap = null;
    expect(computeWarnings(config, {}).map((w) => w.code)).toContain('B1');
  });

  it('C1: usage.overage=bill_overage with overageUnitPriceMinor cleared to null', () => {
    const config = cleanConfig({ models: ['subscription', 'usage'], usage_overage: 'bill_overage' });
    config.policy.usage.overageUnitPriceMinor = null;
    expect(computeWarnings(config, {}).map((w) => w.code)).toContain('C1');
  });

  it('D13: toss provider selected without the CS widget', () => {
    const config = cleanConfig({ providers: ['toss'] });
    expect(config.cs.widget).toBe(false);
    expect(computeWarnings(config, {}).map((w) => w.code)).toContain('D13');
  });

  it('A1: polar provider with upgrade.mode=immediate_prorate_reset_anchor (Polar cannot reset anchor)', () => {
    const config = cleanConfig({ providers: ['polar'], upgrade_mode: 'immediate_prorate_reset_anchor' });
    expect(computeWarnings(config, {}).map((w) => w.code)).toContain('A1');
  });

  it("F(Toss/Portone self): toss is always self-scheduling", () => {
    const config = cleanConfig({ providers: ['toss'] });
    expect(computeWarnings(config, {}).map((w) => w.code)).toContain('F(Toss/Portone self)');
  });

  it('F(Toss/Portone self) [EC:A43]: portone always warns to run schedulerTick, whatever an old config says', () => {
    const oldConfig = cleanConfig({ providers: ['portone'], infra_scheduler: 'provider' });
    expect(computeWarnings(oldConfig, {}).map((w) => w.code)).toContain('F(Toss/Portone self)');
    const selfScheduled = cleanConfig({ providers: ['portone'], infra_scheduler: 'self' });
    expect(computeWarnings(selfScheduled, {}).map((w) => w.code)).toContain('F(Toss/Portone self)');
  });

  it('A13/A16: subscription with grace days > 0 and no notify channel at all', () => {
    const config = cleanConfig({ infra_notify_slack: false, infra_notify_email: 'none' });
    expect(config.policy.dunning.graceDays).toBeGreaterThan(0);
    expect(computeWarnings(config, {}).map((w) => w.code)).toContain('A13/A16');
  });

  it('plans: empty plans[] warns', () => {
    const config = buildConfig({ providers: ['stripe'], infra_notify_slack: true });
    config.plans = [];
    expect(computeWarnings(config, {}).map((w) => w.code)).toContain('plans');
  });
});
