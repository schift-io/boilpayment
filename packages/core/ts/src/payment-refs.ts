// EC:E24 — one provider payment can be named by several refs. Stripe records a renewal under its
// invoice (in_…) but refunds and disputes name the PaymentIntent (pi_…) or charge (ch_…). The kit
// keeps the extra refs of a recorded payment in the operations table (no schema change) and resolves
// an event's ref to the local payment exact-first, then by alias.
import type { Payment, ProviderName, Repo } from './types.js';

const aliasKey = (provider: ProviderName, ref: string) => `payment-ref-alias:${provider}:${ref}`;

/** Record `aliases` as other names of `payment` (idempotent; a ref already pointing elsewhere is kept). */
export async function recordPaymentRefAliases(repo: Repo, payment: Payment, aliases: readonly (string | null | undefined)[], now: Date): Promise<void> {
  for (const ref of aliases) {
    if (!ref || ref === payment.providerRef) continue;
    const key = aliasKey(payment.provider, ref);
    if (await repo.operations.get(key)) continue;
    await repo.operations.put({ id: key, key, kind: 'payment.ref_alias', payloadHash: '', status: 'done',
      result: { paymentId: payment.id }, error: null, createdAt: now, completedAt: now, attempts: 1 });
  }
}

/** The local payment a provider ref names: its own providerRef first, then a recorded alias. */
export async function findLocalPayment(repo: Repo, provider: ProviderName, ref: string): Promise<Payment | null> {
  const [exact] = await repo.payments.list({ provider, providerRef: ref } as Partial<Payment>);
  if (exact) return exact;
  const op = await repo.operations.get(aliasKey(provider, ref));
  const id = (op?.result as { paymentId?: string } | null)?.paymentId;
  return id ? (await repo.payments.get(id)) ?? null : null;
}
