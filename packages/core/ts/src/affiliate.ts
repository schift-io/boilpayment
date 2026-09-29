import { assertSameCurrency, money, scaleMinor } from './money.js';
import type {
  AffiliateCommission,
  AffiliateCommissionFilter,
  AffiliateCommissionTable,
  Money,
} from './types.js';

export type AffiliateCommissionRule =
  | { readonly type: 'rate'; readonly rate: number }
  | { readonly type: 'fixed'; readonly amountMinor: number };

function rateAmountMinor(paidMinor: number, rate: number): number {
  if (!Number.isFinite(rate)) throw new RangeError('affiliate commission rate must be finite');
  if (paidMinor <= 0 || rate <= 0) return 0;
  const match = /^(\d+)(?:\.(\d+))?(?:e([+-]?\d+))?$/.exec(rate.toString().toLowerCase());
  if (!match) throw new RangeError('affiliate commission rate must be a nonnegative number');
  const integer = match[1];
  const fraction = match[2] ?? '';
  const exponent = Number(match[3] ?? '0');
  if (!integer || !Number.isSafeInteger(exponent)) {
    throw new RangeError('affiliate commission rate is outside the supported range');
  }
  let numerator = BigInt(`${integer}${fraction}`);
  const scale = fraction.length - exponent;
  let denominator = 1n;
  if (scale >= 0) denominator = 10n ** BigInt(scale);
  else numerator *= 10n ** BigInt(-scale);
  const result = (BigInt(paidMinor) * numerator) / denominator;
  return Number(result > BigInt(paidMinor) ? BigInt(paidMinor) : result);
}

/** Calculate a nonnegative commission accrual in the payment currency, capped at the amount paid. */
export function calculateAffiliateAccrual(paid: Money, rule: AffiliateCommissionRule): Money {
  const paidMinor = Math.max(0, paid.amountMinor);
  switch (rule.type) {
    case 'rate':
      return money(rateAmountMinor(paidMinor, rule.rate), paid.currency);
    case 'fixed':
      return money(Math.min(paidMinor, Math.max(0, rule.amountMinor)), paid.currency);
  }
}

/** Exact integer reversal: accrual * refunded / paid, ceiled so the affiliate retains no excess. */
export function calculateAffiliateReversal(accrual: Money, refunded: Money, paid: Money): Money {
  assertSameCurrency(accrual, refunded);
  assertSameCurrency(accrual, paid);
  const accrualMinor = Math.max(0, accrual.amountMinor);
  const paidMinor = Math.max(0, paid.amountMinor);
  if (accrualMinor === 0 || paidMinor === 0) return money(0, accrual.currency);
  const refundedMinor = Math.min(paidMinor, Math.max(0, refunded.amountMinor));
  return money(
    Math.min(accrualMinor, scaleMinor(accrualMinor, refundedMinor, paidMinor, 'ceil')),
    accrual.currency,
  );
}

/** Append-only in-memory affiliate commission store. */
export class InMemoryAffiliateCommissionTable implements AffiliateCommissionTable {
  private readonly rows: AffiliateCommission[] = [];
  private readonly byIdempotencyKey = new Map<string, AffiliateCommission>();

  async append(row: AffiliateCommission): Promise<AffiliateCommission> {
    const existing = this.byIdempotencyKey.get(row.idempotencyKey);
    if (existing) return structuredClone(existing);
    const stored = structuredClone(row);
    this.rows.push(stored);
    this.byIdempotencyKey.set(stored.idempotencyKey, stored);
    return structuredClone(stored);
  }

  async list(filter?: AffiliateCommissionFilter): Promise<AffiliateCommission[]> {
    return this.rows.filter(
      (row) =>
        (!filter?.affiliateId || row.affiliateId === filter.affiliateId) &&
        (!filter?.paymentId || row.paymentId === filter.paymentId) &&
        (!filter?.kind || row.kind === filter.kind),
    ).map((row) => structuredClone(row));
  }
}
