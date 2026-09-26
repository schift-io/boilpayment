// EC:C2 EC:C3 EC:C4 EC:C7 — see spec/usage.pseudo.md
import type {
  Clock, IdGen, OutboxItem, PaymentProvider, Plan, Policy, Repo, Subscription, UsageEvent,
} from 'boilpayment-core';
import { periodContaining } from 'boilpayment-core';
import { hoursBetween, previousPeriodStart } from './period.js';

export interface UsageEventInput {
  customerId: string;
  meter: string;
  quantity: number;
  occurredAt: Date;
  idempotencyKey: string;
  meta?: Record<string, unknown> | null;
}

export interface RecordInput {
  event: UsageEventInput;
  sub: Subscription;
  policy: Policy;
  repo: Repo;
  clock: Clock;
  ids: IdGen;
  /** optional — used only to decide whether to enqueue an EC:C4 provider-report outbox item */
  provider?: PaymentProvider | null;
  /**
   * optional — when given, EC:C2's previous-period attribution uses core's exact
   * `periodContaining(sub.createdAt, plan.interval, event.occurredAt, ...)` instead of the
   * `currentPeriod` length approximation (see spec design note). `sub.createdAt` is used as the
   * walk-forward origin because `periodContaining` only walks forward from its anchor — it cannot
   * itself look backward from `currentPeriod.start`, so the anchor must already precede
   * `occurredAt`. Omit (or pass a one-time plan with `interval: null`) to keep the approximation.
   */
  plan?: Plan | null;
}

export interface RecordResult {
  event: UsageEvent;
  duplicated: boolean;
}

export async function record(input: RecordInput): Promise<RecordResult> {
  const { event, sub, policy, repo, clock, ids, provider, plan } = input;

  // EC:C2 — dedupe by idempotency key (mirrors EC:B12's webhook dedupe pattern)
  const existing = await repo.usageEvents.list({ idempotencyKey: event.idempotencyKey } as Partial<UsageEvent>);
  if (existing.length > 0) {
    return { event: existing[0], duplicated: true };
  }

  const receivedAt = clock.now(); // EC:C3 — UTC, from injected Clock

  // EC:C2 — period attribution incl. late-report window
  let periodStart = sub.currentPeriod.start;
  if (event.occurredAt < sub.currentPeriod.start) {
    const lateHours = hoursBetween(receivedAt, sub.currentPeriod.start);
    if (lateHours <= policy.usage.lateReportWindowHours) {
      periodStart = plan?.interval
        ? periodContaining(sub.createdAt, plan.interval, event.occurredAt, sub.anchorDay, policy.period.timezone, policy.period.monthEndAnchor).start
        : previousPeriodStart(sub.currentPeriod); // no plan given — keep the length approximation
    } else {
      periodStart = sub.currentPeriod.start;
    }
  }

  const row: UsageEvent = {
    id: ids.newId(),
    customerId: event.customerId,
    meter: event.meter,
    quantity: event.quantity,
    occurredAt: event.occurredAt,
    receivedAt,
    periodStart,
    idempotencyKey: event.idempotencyKey,
    meta: event.meta ?? null, // EC:C7
  };
  const saved = await repo.usageEvents.put(row);

  // EC:C4 — enqueue provider meter-report if this provider reports usage
  if (provider && provider.capabilities().meters) {
    const item: OutboxItem = {
      id: ids.newId(),
      kind: 'usage.report',
      payload: {
        eventId: saved.id,
        customerId: saved.customerId,
        meter: saved.meter,
        quantity: saved.quantity,
        occurredAt: saved.occurredAt,
        provider: sub.provider,
      },
      status: 'pending',
      attempts: 0,
      nextAttemptAt: clock.now(),
      createdAt: clock.now(),
    };
    await repo.outbox.put(item);
  }

  return { event: saved, duplicated: false };
}
