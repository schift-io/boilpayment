// EC:E24 — resolve the local payment a refund/dispute event names. Stripe records a renewal under
// its invoice (in_…) while refund and dispute events name the PaymentIntent (pi_…) or charge (ch_…).
// Order: exact providerRef, recorded alias, then the provider itself (re-fetch; EC:E3): its other
// refs, and for rows recorded before aliases existed, the same customer's recent payments re-fetched
// once each. A match is recorded as an alias so the next event resolves locally.
import { findLocalPayment, PaymentKitError, recordPaymentRefAliases } from 'boilpayment-core';
import type { Clock, NormalizedEvent, Notifier, Payment, Repo } from 'boilpayment-core';
import type { HandlerCtx } from './process.js';

const LEGACY_SCAN = 24;

function customerRefOf(remote: Payment | null, event: NormalizedEvent): string | null {
  const raw = remote?.raw as { customer?: unknown } | null | undefined;
  const c = raw?.customer;
  if (typeof c === 'string') return c;
  if (c && typeof c === 'object' && typeof (c as { id?: unknown }).id === 'string') return (c as { id: string }).id;
  return event.customerRef ?? null;
}

export async function resolveEventPayment(ctx: HandlerCtx, event: NormalizedEvent, repo: Repo, clock: Clock): Promise<Payment | null> {
  const ref = event.paymentRef;
  if (!ref) return null;
  const name = ctx.provider.name;
  const local = await findLocalPayment(repo, name, ref);
  if (local) return local;
  let remote: Payment | null = null;
  try { remote = await ctx.provider.getPayment(ref); } catch { remote = null; }
  for (const alt of remote?.providerRefAliases ?? []) {
    const hit = await findLocalPayment(repo, name, alt);
    if (hit) { await recordPaymentRefAliases(repo, hit, [ref], clock.now()); return hit; }
  }
  const customerRef = customerRefOf(remote, event);
  if (!customerRef) return null;
  const customer = (await repo.customers.list()).find((c) => c.providerRefs.some((r) => r.provider === name && r.ref === customerRef));
  if (!customer) return null;
  const candidates = (await repo.payments.list({ customerId: customer.id, provider: name } as Partial<Payment>))
    .filter((p) => p.providerRef !== ref)
    .sort((a, b) => b.occurredAt.getTime() - a.occurredAt.getTime())
    .slice(0, LEGACY_SCAN);
  for (const candidate of candidates) {
    let fetched: Payment | null = null;
    try { fetched = await ctx.provider.getPayment(candidate.providerRef); } catch { fetched = null; }
    const aliases = fetched?.providerRefAliases ?? [];
    if (aliases.length) await recordPaymentRefAliases(repo, candidate, aliases, clock.now());
    if (aliases.includes(ref)) return candidate;
  }
  return null;
}

/** Name the local payment the way it was recorded. An event that matches nothing tells a person once
 *  and fails the record (retried: the payment may be recorded later) instead of opening a case for a
 *  customer that does not exist locally (the old 'unknown' customer hit the cs_cases FK). */
export async function localizePaymentEvent(ctx: HandlerCtx, event: NormalizedEvent, kind: 'refund' | 'dispute', repo: Repo, clock: Clock, notifier: Notifier): Promise<NormalizedEvent> {
  if (!event.paymentRef) return event;
  const local = await resolveEventPayment(ctx, event, repo, clock);
  if (local) return { ...event, paymentRef: local.providerRef };
  const noticeKey = `notice:unmatched-${kind}:${ctx.provider.name}:${event.id}`;
  if (!(await repo.operations.get(noticeKey))) {
    const now = clock.now();
    await repo.operations.put({ id: noticeKey, key: noticeKey, kind: 'notice', payloadHash: '', status: 'done', result: null, error: null, createdAt: now, completedAt: now, attempts: 1 });
    await notifier.send({ type: 'cs.needs_human', customerId: null, payload: { kind: `unmatched_${kind}`, provider: ctx.provider.name, eventId: event.id, paymentRef: event.paymentRef, refundRef: event.refundRef ?? null } });
  }
  throw new PaymentKitError(`${kind} event names no local payment`, `unmatched_${kind}`);
}
