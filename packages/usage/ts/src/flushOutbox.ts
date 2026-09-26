// EC:C4 — see spec/usage.pseudo.md
import type { Clock, OutboxItem, PaymentProvider, ProviderName, Repo } from '@schift/payment-kit-core';

export interface FlushOutboxInput {
  repo: Repo;
  providers: Partial<Record<ProviderName, PaymentProvider>>;
  clock: Clock;
  maxAttempts?: number;
}

export interface FlushOutboxResult {
  sent: number;
  failed: number;
  retried: number;
}

function backoffMs(attempts: number): number {
  return Math.min(60, Math.pow(2, attempts)) * 60 * 1000; // exponential minutes, capped at 60min
}

export async function flushOutbox(input: FlushOutboxInput): Promise<FlushOutboxResult> {
  const { repo, providers, clock, maxAttempts = 8 } = input;
  const now = clock.now();
  const pending = await repo.outbox.list({ kind: 'usage.report', status: 'pending' } as Partial<OutboxItem>);

  let sent = 0;
  let failed = 0;
  let retried = 0;

  for (const item of pending) {
    if (item.nextAttemptAt > now) continue;
    const payload = item.payload as {
      eventId: string; customerId: string; meter: string; quantity: number; occurredAt: Date | string; provider: ProviderName;
    };
    const provider = providers[payload.provider];
    if (!provider) continue; // no provider configured for this event — leave pending

    // Resolve the provider-side customer ref (repo.customers.get(customerId).providerRefs) — the
    // outbox payload only ever carried the internal customerId (see spec caveat). Terminal failure,
    // not a transient one: retrying won't fix a customer never linked to this provider.
    const customer = await repo.customers.get(payload.customerId);
    const providerRef = customer?.providerRefs.find((r) => r.provider === payload.provider)?.ref;
    if (!providerRef) {
      item.attempts += 1;
      item.status = 'failed';
      item.payload = { ...item.payload, error: 'no_provider_ref' }; // OutboxItem has no dedicated error field
      await repo.outbox.put(item);
      failed += 1;
      continue;
    }

    item.attempts += 1; // counts every attempt, success or failure
    try {
      await provider.reportUsage({
        meter: payload.meter,
        customerRef: providerRef,
        quantity: payload.quantity,
        occurredAt: new Date(payload.occurredAt),
        idempotencyKey: payload.eventId,
      });
      item.status = 'sent';
      await repo.outbox.put(item);
      sent += 1;
    } catch {
      if (item.attempts >= maxAttempts) {
        item.status = 'failed';
        failed += 1;
      } else {
        item.status = 'pending';
        item.nextAttemptAt = new Date(now.getTime() + backoffMs(item.attempts));
        retried += 1;
      }
      await repo.outbox.put(item);
    }
  }

  return { sent, failed, retried };
}
