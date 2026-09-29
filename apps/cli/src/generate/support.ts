import type { PaykitConfig } from '../config.js';

/** EC:D16 — the kit takes a refund reason only when a reason rule differs from the amount rules. */
export function hasReasonRules(config: PaykitConfig): boolean {
  return Object.values(config.policy.refund.reasons ?? {}).some((v) => v !== 'rules');
}

/** Ready-to-call support methods use persisted payment evidence, never caller-supplied decisions. */
export function supportTs(hasCredits: boolean, reasons = false): string {
  return `  const supportDeps = { policy, providers, repo: full.repo, ledger: full.ledger, clock: full.clock, ids: full.ids, notifier, reporter: licenseReporter };
  const support = {
    requestRefund: (input: Pick<Parameters<typeof requestRefund>[0], 'customerId' | 'paymentId' | 'requestId' | 'requestedAmount'${reasons ? " | 'reason'" : ''}>) => requestRefund({ ...input, ...supportDeps }),
${hasCredits ? `    recoverMissingGrant: (input: { customerId: string; paymentId: string }) => recoverMissingGrant({ ...input, ...supportDeps, grants: { topup, grantForPeriod }, accrueAffiliate: accrueAffiliatePayment }),` : ''}
  };`;
}

export function supportPy(hasCredits: boolean, reasons = false): string {
  return `${hasCredits ? `    class _SupportGrants:
        async def topup(self, *, customer_id: str, payment: Payment, credits: int, policy: Policy, ledger: LedgerStore, repo: Repo, clock: Clock) -> GrantResult:
            return await topup(TopupInput(customer_id=customer_id, payment=payment, credits=credits, policy=policy, ledger=ledger, repo=repo, clock=clock))

        async def grant_for_period(self, *, sub: Subscription, plan: Plan, period: Period, payment: Payment, policy: Policy, ledger: LedgerStore, clock: Clock) -> GrantResult:
            return await grant_for_period(GrantForPeriodInput(sub=sub, plan=plan, period=period, payment=payment, policy=policy, ledger=ledger, clock=clock))

    support_grants = _SupportGrants()
` : ''}
    async def request_support_refund(*, customer_id: str, payment_id: str, request_id: str | None = None, requested_amount: Money | None = None${reasons ? ', reason: RefundReasonInput | None = None' : ''}):
        return await request_refund(RequestRefundInput(customer_id=customer_id, payment_id=payment_id, request_id=request_id, requested_amount=requested_amount, ${reasons ? 'reason=reason, ' : ''}policy=policy, providers=providers, repo=repo, ledger=ledger, clock=clock, ids=ids, notifier=notifier, reporter=license_reporter))
${hasCredits ? `
    async def recover_support_grant(*, customer_id: str, payment_id: str):
        return await recover_missing_grant(RecoverMissingGrantInput(customer_id=customer_id, payment_id=payment_id, policy=policy, providers=providers, repo=repo, ledger=ledger, clock=clock, ids=ids, notifier=notifier, grants=support_grants, accrue_affiliate=_accrue_affiliate_payment, reporter=license_reporter))
` : ''}
    support = {"request_refund": request_support_refund${hasCredits ? ', "recover_missing_grant": recover_support_grant' : ''}}
`;
}
