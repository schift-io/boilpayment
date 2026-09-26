import { PaymentKitError } from 'boilpayment-core';
import type { Clock, PaymentProvider, Repo, Subscription, UsageEvent } from 'boilpayment-core';
import { flushOutbox } from './flushOutbox.js';

export async function reportPeriod(input: { readonly sub: Subscription; readonly events: readonly UsageEvent[]; readonly repo: Repo; readonly provider: PaymentProvider; readonly clock: Clock }): Promise<'awaiting_provider_billing' | 'report_pending' | 'report_failed'> {
  const { sub, events, repo, provider, clock } = input;
  if (provider.name !== sub.provider) throw new PaymentKitError('Usage provider does not match subscription', 'unsupported_usage_billing');
  const existing = await repo.outbox.list({ kind: 'usage.report' });
  for (const event of events) {
    if (existing.some((item) => item.payload.eventId === event.id)) continue;
    await repo.outbox.put({ id: `usage-report:${event.id}`, kind: 'usage.report', payload: { eventId: event.id, customerId: sub.customerId, meter: event.meter, quantity: event.quantity, occurredAt: event.occurredAt, provider: provider.name }, status: 'pending', attempts: 0, nextAttemptAt: clock.now(), createdAt: clock.now() });
  }
  await flushOutbox({ repo, providers: { [provider.name]: provider }, clock });
  const reports = await repo.outbox.list({ kind: 'usage.report' });
  const relevant = reports.filter((item) => events.some((event) => item.payload.eventId === event.id));
  if (relevant.some((item) => item.status === 'failed')) return 'report_failed';
  if (relevant.some((item) => item.status === 'pending')) return 'report_pending';
  // Reporting acceptance is not invoice/payment confirmation; provider pricing setup still applies.
  return 'awaiting_provider_billing';
}
