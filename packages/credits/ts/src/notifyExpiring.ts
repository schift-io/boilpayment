// spec: packages/credits/spec/credits.pseudo.md — EC:B16
import { Clock, LedgerStore, Notifier, OutboxItem, Policy, Repo } from '@schift/payment-kit-core';

export interface ExpiringNotice {
  customerId: string;
  expiresAt: Date;
  amount: number;
}

export interface NotifyExpiringInput {
  /** Omit to scan every customer (via repo.customers.list()). */
  customerId?: string;
  ledger: LedgerStore;
  repo: Repo;
  /** EC:B16 — sent as `'credits.expiring'` (its own NotifyType; `'card.expiring'` is the card on file). */
  notifier: Notifier;
  policy: Policy;
  clock: Clock;
}

export interface NotifyExpiringResult {
  pending: ExpiringNotice[];
}

const DAY_MS = 86_400_000;
const NOTICE_KIND = 'credits.expiry_notice';

function dayBucket(d: Date): string {
  return d.toISOString().slice(0, 10);
}

// EC:B16 — paid-pool credit buckets (grant remainders) entering their expiry-notice window
// (policy.credits.expiryNoticeDays), not already noticed today. Idempotent per
// (customer, expiresAt bucket, day): a same-day rerun of the cron returns nothing new for a
// bucket already reported today; tomorrow's run reports it again until it actually expires
// (repeated daily reminders are intended, not spam — "spam" here means only the same-day rerun).
export async function notifyExpiring(input: NotifyExpiringInput): Promise<NotifyExpiringResult> {
  const { customerId, ledger, repo, policy, clock } = input;
  const noticeDays = policy.credits.expiryNoticeDays;
  if (noticeDays === null) return { pending: [] };

  const now = clock.now();
  const windowEnd = new Date(now.getTime() + noticeDays * DAY_MS);
  const today = dayBucket(now);

  const customerIds = customerId ? [customerId] : (await repo.customers.list()).map((c) => c.id);

  const pending: ExpiringNotice[] = [];
  for (const cid of customerIds) {
    const balance = await ledger.balance(cid, 'paid', now);
    for (const bucket of balance.expiring) {
      if (bucket.amount <= 0) continue;
      // balance().expiring already excludes expiresAt <= now (EC:B14); the lower bound here is
      // defensive in case a future LedgerStore implementation doesn't pre-filter.
      if (bucket.expiresAt.getTime() < now.getTime() || bucket.expiresAt.getTime() > windowEnd.getTime()) continue;

      const dedupId = `credits-expiry-notice:${cid}:${bucket.expiresAt.toISOString()}:${today}`;
      const already = await repo.outbox.get(dedupId);
      if (already) continue;

      const marker: OutboxItem = {
        id: dedupId,
        kind: NOTICE_KIND,
        payload: { customerId: cid, expiresAt: bucket.expiresAt.toISOString(), amount: bucket.amount },
        status: 'sent',
        attempts: 1,
        nextAttemptAt: now,
        createdAt: now,
      };
      await repo.outbox.put(marker);
      pending.push({ customerId: cid, expiresAt: bucket.expiresAt, amount: bucket.amount });
      // EC:B16 — the outbox marker above is written first, so a send that throws is not retried
      // into a duplicate notice on the next sweep.
      await input.notifier.send({
        type: 'credits.expiring',
        customerId: cid,
        payload: { amount: bucket.amount, expiresAt: bucket.expiresAt.toISOString() },
      });
    }
  }

  return { pending };
}
