import { calculateAffiliateReversal } from 'boilpayment-core';
import type { Clock, LedgerStore, Payment, Refund, Repo } from 'boilpayment-core';

interface AppendAffiliateReversalsInput {
  readonly repo: Repo;
  readonly ledger: LedgerStore;
  readonly clock: Clock;
  readonly payment: Payment;
  readonly refund: Refund;
}

/** Append each accrual's proportional refund reversal without mutating the original accrual. */
export async function appendAffiliateReversals(input: AppendAffiliateReversalsInput): Promise<void> {
  const { repo, ledger, clock, payment, refund } = input;
  if (refund.status !== 'succeeded') return;
  const rows = await repo.affiliateCommissions.list({ paymentId: payment.id });
  const accruals = rows.filter((row) => row.kind === 'accrual');
  for (const accrual of accruals) {
    await ledger.transaction(`affiliate-commission:${payment.id}:${accrual.id}`, async () => {
      const freshRows = await repo.affiliateCommissions.list({ paymentId: payment.id });
      const idempotencyKey = `affiliate-reversal:${refund.id}:${accrual.id}`;
      const reversed = freshRows
        .filter((row) => row.kind === 'reversal' && row.relatedAccrualId === accrual.id)
        .reduce((sum, row) => sum + row.amount.amountMinor, 0);
      const calculated = calculateAffiliateReversal(accrual.amount, refund.amount, payment.amount);
      await repo.affiliateCommissions.append({
        id: idempotencyKey,
        kind: 'reversal',
        affiliateId: accrual.affiliateId,
        paymentId: payment.id,
        refundId: refund.id,
        relatedAccrualId: accrual.id,
        amount: { ...calculated, amountMinor: Math.min(calculated.amountMinor, Math.max(0, accrual.amount.amountMinor - reversed)) },
        idempotencyKey,
        createdAt: clock.now(),
      });
    });
  }
}
