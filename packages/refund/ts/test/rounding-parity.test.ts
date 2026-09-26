// [EC:J9] refund credit rounding is half away from zero, the same rule the Python kit uses.
import { describe, expect, it } from 'vitest';
import { money, roundHalfAwayFromZero } from 'boilpayment-core';
import { applyRounding } from '../src/util.js';
import { creditsForAmount } from '../src/external.js';

function auditValues(): number[] {
  const vals = [0.5, 1.5, 2.5, 0.49999999999999994, 4503599627370495.5, 4503599627370497, 2 ** 53 - 1, 1e15 + 0.5, 12.5000000001, 12.4999999999];
  let s = 12345;
  const rnd = () => (s = (s * 1103515245 + 12345) % 2147483648) / 2147483648;
  for (let i = 0; i < 2000; i++) { const k = Math.floor(rnd() * 1e6); vals.push(k + 0.5, k + rnd(), (k * 7 + 3) / 2); }
  return vals;
}

describe('[EC:J9] refund rounding parity', () => {
  it('[EC:J9] round_credits is half away from zero', () => {
    const vals = auditValues();
    expect(vals.map((v) => applyRounding(v, 'round_credits'))).toEqual(vals.map(roundHalfAwayFromZero));
    expect(applyRounding(2.5, 'round_credits')).toBe(3);
  });
  it('[EC:J9] external refund credits', () => {
    expect([[250, 100], [25, 10], [35, 10], [1050, 100], [249, 100]].map(([a, u]) => creditsForAmount(a, u))).toEqual([3, 3, 4, 11, 2]);
    expect(creditsForAmount(500, 0)).toBe(0);
  });
  it('[EC:J10] money accepts integral numbers and refuses fractions, NaN, unsafe', () => {
    expect(money(50000.0, 'krw').amountMinor).toBe(50000);
    for (const bad of [1.5, Number.NaN, Number.POSITIVE_INFINITY, 2 ** 53]) expect(() => money(bad, 'krw')).toThrow();
  });
});
