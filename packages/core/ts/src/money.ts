/**
 * Money value-object helpers. Mirrors packages/core/py/src/boilpayment_core/money.py exactly.
 * EC:B8 (grant unit price) / EC:D6 (refund in payment currency) rely on these staying minor-unit-exact.
 */
import { Money } from './types.js';

/** Currencies with zero minor-unit decimals (amount_minor IS the amount, no /100). */
export const ZERO_DECIMAL_CURRENCIES: readonly string[] = ['KRW', 'JPY'];

export type Rounding = 'floor' | 'ceil' | 'round';

export function money(amountMinor: number, currency: string): Money {
  if (!Number.isInteger(amountMinor)) {
    throw new Error(`amountMinor must be an integer, got ${amountMinor}`);
  }
  return { amountMinor, currency: currency.toUpperCase() };
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
  const rounded = rounding === 'floor' ? Math.floor(raw) : rounding === 'ceil' ? Math.ceil(raw) : Math.round(raw);
  return money(rounded, m.currency);
}
