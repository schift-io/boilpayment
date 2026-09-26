// EC:E3 EC:I9 — resolves the LOCAL customer/payment/subscription a webhook event is about, by
// looking up the local row via (provider, providerRef) — never trusts the provider-adapter's own
// ref fields as local identity directly (see handlers.ts EC:E3 note: those are best-effort,
// restored from checkout metadata). Best-effort in the other direction too: any id that can't be
// resolved stays null (e.g. the event predates any local row, or references an entity created
// outside this app). Used by both receive() (first sighting) and process() (re-verified, may
// resolve better once more local rows exist) so a customer-scoped CS timeline can query
// webhook_events directly instead of a full table scan.
import type { NormalizedEvent, PaymentProvider, Repo } from 'boilpayment-core';

export interface WebhookIdentity {
  customerId: string | null;
  paymentId: string | null;
  subscriptionId: string | null;
}

export async function resolveWebhookIdentity(
  repo: Repo,
  provider: PaymentProvider,
  event: NormalizedEvent,
): Promise<WebhookIdentity> {
  let customerId: string | null = null;
  let paymentId: string | null = null;
  let subscriptionId: string | null = null;

  if (event.paymentRef) {
    const [payment] = await repo.payments.list({ provider: provider.name, providerRef: event.paymentRef });
    if (payment) {
      paymentId = payment.id;
      customerId = payment.customerId;
    }
  }
  if (event.subscriptionRef) {
    const [sub] = await repo.subscriptions.list({ provider: provider.name, providerRef: event.subscriptionRef });
    if (sub) {
      subscriptionId = sub.id;
      customerId ??= sub.customerId;
    }
  }
  // Last resort — Customer has no (provider, providerRef) column to filter on (providerRefs is a
  // list), so this is a full scan. Only reached when payment/subscription lookups didn't already
  // give us a customerId.
  if (!customerId && event.customerRef) {
    const customers = await repo.customers.list();
    const match = customers.find((c) => c.providerRefs.some((r) => r.provider === provider.name && r.ref === event.customerRef));
    if (match) customerId = match.id;
  }

  return { customerId, paymentId, subscriptionId };
}
