// [EC:J6] ISO 4217 minor units; [EC:J7] safe integers, exact rational scaling, one .5 rule.
import { describe, expect, it } from 'vitest';
import { currencyExponent, money, mulMoneyRatio, prorationFraction, roundHalfAwayFromZero, scaleMinor } from '../src/index.js';

describe('[EC:J6] currencyExponent', () => {
  it('[EC:J6] zero, two and three decimals', () => {
    expect(['KRW', 'JPY', 'VND', 'CLP', 'usd', 'EUR', 'KWD', 'BHD', 'TND'].map(currencyExponent)).toEqual([0, 0, 0, 0, 2, 2, 3, 3, 3]);
  });
});

describe('[EC:J7] exact money math', () => {
  it('[EC:J7] money() refuses integers beyond 2^53 - 1', () => {
    expect(() => money(2 ** 53 + 2, 'USD')).toThrow(/safe integer/);
    expect(money(Number.MAX_SAFE_INTEGER, 'USD').amountMinor).toBe(Number.MAX_SAFE_INTEGER);
  });
  it('[EC:J7] 8.7 of 30 days remaining on a 100 delta prorates to 29, not 28', () => {
    const DAY = 86_400_000;
    const now = new Date('2026-01-01T00:00:00Z');
    const f = prorationFraction({ start: new Date(now.getTime() - 21.3 * DAY), end: new Date(now.getTime() + 8.7 * DAY) }, now, 'fixed_30');
    expect(scaleMinor(100, f.num, f.den, 'floor')).toBe(29);
  });
  it('[EC:J7] rounding modes, including negatives', () => {
    expect([scaleMinor(5, 1, 2, 'floor'), scaleMinor(5, 1, 2, 'ceil'), scaleMinor(5, 1, 2, 'round'), scaleMinor(-5, 1, 2, 'round'), scaleMinor(-5, 1, 2, 'floor')]).toEqual([2, 3, 3, -3, -3]);
    expect([roundHalfAwayFromZero(2.5), roundHalfAwayFromZero(-2.5), mulMoneyRatio(money(-5, 'USD'), 0.5, 'round').amountMinor]).toEqual([3, -3, -3]);
  });
});
