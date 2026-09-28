import { PaymentKitError } from 'boilpayment-core';
import type { Clock, LedgerStore, PaymentProvider, Period, Policy, ProviderName, Repo } from 'boilpayment-core';
import { settlePeriod } from './settlePeriod.js';
import type { SettlePeriodResult } from './settlePeriod.js';

export interface SettleDuePeriodsInput {
  readonly policy: Policy;
  readonly repo: Repo;
  readonly ledger: LedgerStore;
  readonly providers: Partial<Record<ProviderName, PaymentProvider>>;
  readonly clock: Clock;
}
export interface DuePeriodSettlement {
  readonly subscriptionId: string;
  readonly period: Period;
  readonly result: SettlePeriodResult;
}

/** Discover original usage periods and persisted charge attempts, including after renewal. */
export async function settleDuePeriods(input: SettleDuePeriodsInput): Promise<DuePeriodSettlement[]> {
  const { repo, policy, clock } = input;
  const subscriptions = await repo.subscriptions.list();
  const results: DuePeriodSettlement[] = [];
  const errors: Array<{ subscriptionId: string; code: string; message: string }> = [];
  for (const sub of subscriptions) {
    // EC:A75 — one subscription's failure (a refused charge, a bad row) is reported after every other
    // subscription has been settled; it never stops the rest of this run.
    try {
      const events = await repo.usageEvents.list({ customerId: sub.customerId });
      const payments = (await repo.payments.list({ subscriptionId: sub.id })).filter((payment) => payment.kind === 'overage' || payment.kind === 'subscription' && payment.status === 'succeeded');
      if (!events.length && !payments.length) continue;
      // EC:A72 — a sign-up whose first charge never succeeded (closed incomplete/expired) never owned usage.
      const owners = [];
      for (const candidate of subscriptions.filter((c) => c.customerId === sub.customerId)) {
        if (candidate.status !== 'incomplete' && candidate.status !== 'expired') { owners.push(candidate); continue; }
        if ((await repo.payments.list({ subscriptionId: candidate.id })).some((pay) => pay.status === 'succeeded')) owners.push(candidate);
      }
      if (events.length && !owners.some((o) => o.id === sub.id)) continue;
      if (events.length && owners.length > 1) {
        throw new PaymentKitError('Customer usage cannot identify one subscription', 'ambiguous_usage_subscription');
      }
      const periods = new Map<number, Period>();
      for (const payment of payments) {
        if (payment.period) periods.set(payment.period.start.getTime(), payment.period);
      }
      for (const event of events) {
        const start = event.periodStart.getTime();
        if (periods.has(start)) continue;
        if (start === sub.currentPeriod.start.getTime()) {
          periods.set(start, sub.currentPeriod);
        } else {
          throw new PaymentKitError('Historical usage requires an original payment period', 'invalid_usage_period');
        }
      }
      for (const period of [...periods.values()].sort((a, b) => a.start.getTime() - b.start.getTime())) {
        if (period.end > clock.now()) continue;
        const provider = input.providers[sub.provider];
        if (!provider) throw new PaymentKitError('Usage billing provider is not configured', 'unsupported_usage_billing');
        results.push({ subscriptionId: sub.id, period, result: await settlePeriod({ sub, period, policy, repo, ledger: input.ledger, provider, clock }) });
      }
    } catch (err) {
      errors.push({ subscriptionId: sub.id, code: err instanceof PaymentKitError ? err.code : 'usage_settlement_error', message: err instanceof Error ? err.message : String(err) });
    }
  }
  if (errors.length) throw new PaymentKitError('some usage periods could not be settled', 'usage_settlement_errors', { errors, results });
  return results;
}
