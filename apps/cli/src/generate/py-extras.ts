// EC:C10 reservations and EC:I10 reports for the generated paykit/index.py. Kept apart from
// py-entry.ts so that file stays readable; each block is emitted only when its wizard answer is on.

export function extrasImportsPy(hasReservations: boolean, hasReports: boolean): string[] {
  const l: string[] = [];
  if (hasReports) {
    l.push(`from datetime import datetime`);
    l.push(`from boilpayment.cs import settlement_report`);
  }
  if (hasReservations) {
    l.push(`from boilpayment.usage import commit as commit_reservation, list_reservations, release as release_reservation, reserve as reserve_budget, sweep_reservations`);
  }
  return l;
}

export function extrasFunctionsPy(hasReservations: boolean, hasReports: boolean, hasSubscription = false): string[] {
  const l: string[] = [];
  if (hasReservations) {
    if (hasSubscription) {
      l.push(`    async def _reserve(*, customer_id: str, job_id: str, amount: int, subscription_id: str | None = None):`);
      l.push(`        """EC:C10 — hold budget before long-running work starts. EC:C11 — an unentitled subscription is refused."""`);
      l.push(`        sub = await repo.subscriptions.get(subscription_id) if subscription_id else await current_subscription(customer_id)`);
      l.push(`        # EC:A44 — only the customer's own subscription counts; grace blocks spending when the policy says so.`);
      l.push(`        if sub is not None and sub.customer_id != customer_id:`);
      l.push(`            raise PaymentKitError("subscription does not belong to this customer", "subscription_not_owned")`);
      l.push(`        if sub is not None and sub.status == "past_due" and policy.dunning.usage_during_grace == "block":`);
      l.push(`            raise PaymentKitError(f"subscription {sub.id} is past due", "grace_usage_blocked")`);
      l.push(`        return await reserve_budget(customer_id=customer_id, job_id=job_id, amount=amount, policy=policy, ledger=ledger, clock=clock, sub=sub)`);
    } else {
      l.push(`    async def _reserve(*, customer_id: str, job_id: str, amount: int):`);
      l.push(`        """EC:C10 — hold budget before long-running work starts."""`);
      l.push(`        return await reserve_budget(customer_id=customer_id, job_id=job_id, amount=amount, policy=policy, ledger=ledger, clock=clock)`);
    }
    l.push('');
    l.push(`    async def _commit(*, customer_id: str, job_id: str, amount: int):`);
    l.push(`        """EC:C10 — the job succeeded: charge what it used (<= reserved)."""`);
    l.push(`        return await commit_reservation(customer_id=customer_id, job_id=job_id, amount=amount, policy=policy, ledger=ledger, clock=clock)`);
    l.push('');
    l.push(`    async def _release(*, customer_id: str, job_id: str):`);
    l.push(`        """EC:C10 — the job failed or was cancelled: charge nothing."""`);
    l.push(`        return await release_reservation(customer_id=customer_id, job_id=job_id, ledger=ledger)`);
    l.push('');
    l.push(`    async def _list_reservations(customer_id: str):`);
    l.push(`        return await list_reservations(customer_id=customer_id, ledger=ledger)`);
    l.push('');
    l.push(`    reservations = {"reserve": _reserve, "commit": _commit, "release": _release, "list": _list_reservations}`);
    l.push('');
  }
  if (hasReports) {
    l.push(`    async def _settlement(*, start: datetime, end: datetime):`);
    l.push(`        """EC:I10 — read-only totals for [start, end)."""`);
    l.push(`        return await settlement_report(repo=repo, ledger=ledger, start=start, end=end)`);
    l.push('');
    l.push(`    reports = {"settlement": _settlement}`);
    l.push('');
  }
  return l;
}
