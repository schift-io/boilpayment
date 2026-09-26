// spec: packages/core/spec/core.pseudo.md [EC:G1] [EC:G2] [EC:G5]
import { describe, expect, it } from 'vitest';
import { nextPeriod, prorationRatio } from '../src/period.js';

describe('EC:G1 next_period — month-end anchor', () => {
  it('EC:G1 clamp_keep_original_day: 2026-01-31 -> 2026-02-28 -> 2026-03-31 (anchorDay=31 retried each cycle)', () => {
    const p0 = { start: new Date('2026-01-01T00:00:00.000Z'), end: new Date('2026-01-31T00:00:00.000Z') };
    const p1 = nextPeriod(p0, 'month', 31, 'UTC', 'clamp_keep_original_day');
    expect(p1).toEqual({ start: new Date('2026-01-31T00:00:00.000Z'), end: new Date('2026-02-28T00:00:00.000Z') });
    const p2 = nextPeriod(p1, 'month', 31, 'UTC', 'clamp_keep_original_day');
    expect(p2).toEqual({ start: new Date('2026-02-28T00:00:00.000Z'), end: new Date('2026-03-31T00:00:00.000Z') });
  });

  it('EC:G1 clamp_permanently: 2026-01-31 -> 2026-02-28 -> 2026-03-28 (clamped day becomes permanent)', () => {
    const p0 = { start: new Date('2026-01-01T00:00:00.000Z'), end: new Date('2026-01-31T00:00:00.000Z') };
    const p1 = nextPeriod(p0, 'month', 31, 'UTC', 'clamp_permanently');
    expect(p1).toEqual({ start: new Date('2026-01-31T00:00:00.000Z'), end: new Date('2026-02-28T00:00:00.000Z') });
    const p2 = nextPeriod(p1, 'month', 31, 'UTC', 'clamp_permanently');
    expect(p2).toEqual({ start: new Date('2026-02-28T00:00:00.000Z'), end: new Date('2026-03-28T00:00:00.000Z') });
  });

  it('EC:G1/G5 leap year: anchorDay=29 lands on 2028-02-29 (2028 is a leap year, no clamp)', () => {
    const p0 = { start: new Date('2027-12-29T00:00:00.000Z'), end: new Date('2028-01-29T00:00:00.000Z') };
    const p1 = nextPeriod(p0, 'month', 29, 'UTC', 'clamp_keep_original_day');
    expect(p1).toEqual({ start: new Date('2028-01-29T00:00:00.000Z'), end: new Date('2028-02-29T00:00:00.000Z') });
  });

  it('EC:G1/G5 non-leap year: anchorDay=29 clamps to 2027-02-28, then recovers to 2027-03-29', () => {
    const p0 = { start: new Date('2026-12-29T00:00:00.000Z'), end: new Date('2027-01-29T00:00:00.000Z') };
    const p1 = nextPeriod(p0, 'month', 29, 'UTC', 'clamp_keep_original_day');
    expect(p1).toEqual({ start: new Date('2027-01-29T00:00:00.000Z'), end: new Date('2027-02-28T00:00:00.000Z') });
    const p2 = nextPeriod(p1, 'month', 29, 'UTC', 'clamp_keep_original_day');
    expect(p2).toEqual({ start: new Date('2027-02-28T00:00:00.000Z'), end: new Date('2027-03-29T00:00:00.000Z') });
  });

  it('EC:G1 interval=year adds 12 months, keeping the (clamped) day', () => {
    const p0 = { start: new Date('2027-02-28T00:00:00.000Z'), end: new Date('2027-02-28T00:00:00.000Z') };
    const p1 = nextPeriod(p0, 'year', 29, 'UTC', 'clamp_keep_original_day');
    // 2028 is a leap year: anchorDay=29 fits in Feb 2028
    expect(p1).toEqual({ start: new Date('2027-02-28T00:00:00.000Z'), end: new Date('2028-02-29T00:00:00.000Z') });
  });
});

describe('EC:G2 proration ratio — both denominators', () => {
  it('EC:G2 actual_days_in_period: 31-day period (Jan), 16 of 31 days remaining', () => {
    const period = { start: new Date('2026-01-01T00:00:00.000Z'), end: new Date('2026-02-01T00:00:00.000Z') };
    const now = new Date('2026-01-16T00:00:00.000Z');
    const ratio = prorationRatio(period, now, 'actual_days_in_period');
    expect(ratio).toBeCloseTo(16 / 31, 12);
  });

  it('EC:G2 fixed_30: same period/now, denominator forced to 30 regardless of actual length', () => {
    const period = { start: new Date('2026-01-01T00:00:00.000Z'), end: new Date('2026-02-01T00:00:00.000Z') };
    const now = new Date('2026-01-16T00:00:00.000Z');
    const ratio = prorationRatio(period, now, 'fixed_30');
    expect(ratio).toBeCloseTo(16 / 30, 12);
  });

  it('EC:G2 mid-period 30-day period is 0.5 remaining under both denominators', () => {
    const period = { start: new Date('2026-03-01T00:00:00.000Z'), end: new Date('2026-03-31T00:00:00.000Z') };
    const mid = new Date('2026-03-16T00:00:00.000Z');
    expect(prorationRatio(period, mid, 'actual_days_in_period')).toBe(0.5);
    expect(prorationRatio(period, mid, 'fixed_30')).toBe(0.5);
  });

  it('EC:G2 ratio clamps to [0,1] outside the period', () => {
    const period = { start: new Date('2026-01-01T00:00:00.000Z'), end: new Date('2026-02-01T00:00:00.000Z') };
    expect(prorationRatio(period, new Date('2026-03-01T00:00:00.000Z'), 'actual_days_in_period')).toBe(0);
    expect(prorationRatio(period, new Date('2025-12-01T00:00:00.000Z'), 'actual_days_in_period')).toBe(1);
  });
});
