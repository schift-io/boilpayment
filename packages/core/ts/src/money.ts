/**
 * Money value-object helpers. Mirrors packages/core/py/src/boilpayment_core/money.py exactly.
 * EC:B8 (grant unit price) / EC:D6 (refund in payment currency) rely on these staying minor-unit-exact.
 */
import { Money } from './types.js';

/**
 * EC:J6 — ISO 4217 minor-unit exponents. Zero-decimal: amount_minor IS the amount. Three-decimal:
 * amount_minor is thousandths. Everything else has two decimals.
 */
export const ZERO_DECIMAL_CURRENCIES: readonly string[] = [
  'BIF', 'CLP', 'DJF', 'GNF', 'ISK', 'JPY', 'KMF', 'KRW', 'PYG', 'RWF', 'UGX', 'UYI', 'VND', 'VUV', 'XAF', 'XOF', 'XPF',
];
export const THREE_DECIMAL_CURRENCIES: readonly string[] = ['BHD', 'IQD', 'JOD', 'KWD', 'LYD', 'OMR', 'TND'];

/** EC:J6 — number of minor-unit decimals for a currency (0, 2 or 3). */
export function currencyExponent(currency: string): 0 | 2 | 3 {
  const c = currency.toUpperCase();
  if (ZERO_DECIMAL_CURRENCIES.includes(c)) return 0;
  if (THREE_DECIMAL_CURRENCIES.includes(c)) return 3;
  return 2;
}

export type Rounding = 'floor' | 'ceil' | 'round';

/** EC:J7 — amounts are safe integers (|n| <= 2^53 - 1); anything larger loses cents silently. */
export function money(amountMinor: number, currency: string): Money {
  if (!Number.isSafeInteger(amountMinor)) {
    throw new Error(`amountMinor must be a safe integer, got ${amountMinor}`);
  }
  return { amountMinor, currency: currency.toUpperCase() };
}

/** EC:J7 — half away from zero, identical in TS and Python (Math.round and round() differ at .5). */
export function roundHalfAwayFromZero(x: number): number {
  return x < 0 ? -Math.round(-x) : Math.round(x);
}

/**
 * EC:J7 — exact `amount * num / den` in integers (no float), with explicit rounding. Used for
 * proration and clamps so a result that is mathematically whole never lands one unit short.
 */
export function scaleMinor(amount: number, num: number, den: number, rounding: Rounding = 'floor'): number {
  for (const [n, v] of [['amount', amount], ['num', num], ['den', den]] as const) {
    if (!Number.isSafeInteger(v)) throw new Error(`${n} must be a safe integer, got ${v}`);
  }
  if (den === 0) throw new Error('den must not be 0');
  let p = BigInt(amount) * BigInt(num);
  let d = BigInt(den);
  if (d < 0n) { p = -p; d = -d; }
  const q = p / d; // truncates toward zero
  const r = p % d;
  let out = q;
  if (r !== 0n) {
    const negative = p < 0n;
    if (rounding === 'floor') out = negative ? q - 1n : q;
    else if (rounding === 'ceil') out = negative ? q : q + 1n;
    else {
      const twice = (r < 0n ? -r : r) * 2n;
      if (twice >= d) out = negative ? q - 1n : q + 1n; // half away from zero
    }
  }
  const n = Number(out);
  if (!Number.isSafeInteger(n)) throw new Error(`result ${out} is not a safe integer`);
  return n;
}

export function assertSameCurrency(a: Money, b: Money): void {
  if (a.currency !== b.currency) {
    throw new Error(`currency mismatch: ${a.currency} vs ${b.currency}`);
  }
}

export function addMoney(a: Money, b: Money): Money {
  assertSameCurrency(a, b);
  return money(a.amountMinor + b.amountMinor, a.currency);
}

export function mulMoneyRatio(m: Money, ratio: number, rounding: Rounding = 'floor'): Money {
  const raw = m.amountMinor * ratio;
  const rounded = rounding === 'floor' ? Math.floor(raw) : rounding === 'ceil' ? Math.ceil(raw) : roundHalfAwayFromZero(raw);
  return money(rounded, m.currency);
}
