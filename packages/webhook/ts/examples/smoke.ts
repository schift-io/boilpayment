// Smoke test — real code path (no mocks of our own modules), only fake PaymentProviders
// and a fake lifecycle dep. Run (after `tsc` build): node <outDir>/examples/smoke.js
import {
  DEFAULT_POLICY, FixedClock, InMemoryRepo, LedgerStore, NormalizedEvent, Notification, Notifier, Payment,
  PaymentProvider, ProviderName, Refund, SequentialIdGen, Subscription, WebhookSignatureError,
} from 'boilpayment-core';
import { defaultHandlers, getGrantsForCheckout, process as processWebhook, receive } from '../src/index.js';
import type { LifecycleDeps } from '../src/index.js';

const ids = new SequentialIdGen('id_');
const clock = new FixedClock(new Date('2026-02-02T00:00:00Z'));
const repo = new InMemoryRepo();
const policy = DEFAULT_POLICY;

const fixedPayment: Payment = {
  id: 'pay_1', customerId: 'cust_1', provider: 'stripe', providerRef: 'pi_1', subscriptionId: 'sub_1',
  amount: { amountMinor: 2900, currency: 'USD' }, status: 'succeeded', kind: 'subscription',
  period: { start: new Date('2026-02-01T00:00:00Z'), end: new Date('2026-03-01T00:00:00Z') },
  occurredAt: clock.now(), failure: null,
};
const fixedSub: Subscription = {
  id: 'sub_1', customerId: 'cust_1', planId: 'plan_pro', provider: 'stripe', providerRef: 'sub_stripe_1',
  status: 'active', currentPeriod: fixedPayment.period!, anchorDay: 1, cancelAtPeriodEnd: false,
  graceUntil: null, billingKey: null, scheduledPlanId: null, createdAt: new Date('2026-01-01T00:00:00Z'),
};

// EC:E4 — accepts header x-sig: ok, else throws WebhookSignatureError. Parses rawBody JSON -> NormalizedEvent.
// Also stamps id/customerId/planId/subscriptionId with provider-adapter "best-effort" values on
// getPayment/getSubscription (per team-lead: these must NOT be trusted as local identity by handlers).
class FakeProvider implements PaymentProvider {
  readonly name: ProviderName = 'stripe';
  capabilities() { return { nativeSubscriptions: true, partialRefund: true, meters: false, scheduling: 'provider' as const, webhookSignature: true }; }
  async createCustomer() { return { ref: 'cus_fake' }; }
  async createCheckout(): Promise<never> { throw new Error('unused'); }
  async getPayment(): Promise<Payment> { return { ...fixedPayment, id: '', customerId: '' }; } // provider doesn't know local ids
  async listPayments() { return []; }
  async getSubscription(): Promise<Subscription> { return { ...fixedSub, id: '', customerId: '' }; }
  async changeSubscription(): Promise<never> { throw new Error('unused'); }
  async cancelSubscription(): Promise<never> { throw new Error('unused'); }
  async chargeBillingKey(): Promise<never> { throw new Error('unused'); }
  async refund(): Promise<Refund> { throw new Error('unused'); }
  async reportUsage(): Promise<void> {}
  async verifyWebhook(input: { headers: Record<string, string>; rawBody: string }): Promise<NormalizedEvent> {
    if (input.headers['x-sig'] !== 'ok') throw new WebhookSignatureError();
    const parsed = JSON.parse(input.rawBody);
    return {
      id: parsed.id, provider: 'stripe', type: parsed.type, occurredAt: new Date(parsed.occurredAt),
      customerRef: parsed.customerRef ?? null, subscriptionRef: parsed.subscriptionRef ?? null,
      paymentRef: parsed.paymentRef ?? null, amount: null, raw: parsed,
    };
  }
}
const provider = new FakeProvider();

// EC:F — Toss-like: no native provider-side subscription; getSubscription must never be called.
class TossLikeProvider extends FakeProvider {
  readonly name: ProviderName = 'toss';
  capabilities() { return { ...super.capabilities(), nativeSubscriptions: false }; }
  async getSubscription(): Promise<never> { throw new Error('unsupported: toss has no native subscription'); }
}
const tossProvider = new TossLikeProvider();

const lifecycleCalls: string[] = [];
const fakeLifecycle: LifecycleDeps = {
  async onRenewalPaid(input) { lifecycleCalls.push(`onRenewalPaid(${input.sub.id})`); },
  dunning: { async onPaymentFailed(input) { lifecycleCalls.push(`onPaymentFailed(${input.sub.id})`); } },
};

const notifications: Notification[] = [];
const collectingNotifier: Notifier = { async send(n) { notifications.push(n); } };

async function main() {
  await repo.subscriptions.put(fixedSub);
  await repo.payments.put(fixedPayment); // local row must pre-exist — handlers no longer trust provider-guessed ids

  const goodBody = JSON.stringify({ id: 'evt_1', type: 'payment.succeeded', occurredAt: clock.now().toISOString(), subscriptionRef: fixedSub.providerRef, paymentRef: fixedPayment.providerRef });

  // ── EC:E4 — bad signature -> 400, nothing stored ──
  const bad = await receive({ provider, headers: { 'x-sig': 'nope' }, rawBody: goodBody, repo, clock });
  console.log('[receive bad sig]', JSON.stringify(bad));

  // ── EC:E5 — good signature -> 200, stored ──
  const ok = await receive({ provider, headers: { 'x-sig': 'ok' }, rawBody: goodBody, repo, clock });
  console.log('[receive ok]', JSON.stringify(ok));
  const stored = await repo.webhookEvents.get(ok.eventId!);
  console.log('[stored record status]', stored?.status);

  // ── EC:E5 — same event id again -> 200, duplicated ──
  const dup = await receive({ provider, headers: { 'x-sig': 'ok' }, rawBody: goodBody, repo, clock });
  console.log('[receive dup]', JSON.stringify(dup));

  // ── EC:E3 — process(): local repo rows resolved by providerRef, verified via re-fetch, handler called ──
  const fakeLedger = { entries: async () => [] } as unknown as LedgerStore;
  const handlers = defaultHandlers({ policy, ledger: fakeLedger, repo, notifier: collectingNotifier, clock, ids, lifecycle: fakeLifecycle });
  await processWebhook({ eventId: ok.eventId!, providers: { stripe: provider }, handlers, repo, clock });
  const processed = await repo.webhookEvents.get(ok.eventId!);
  console.log('[process] record status:', processed?.status, 'lifecycle calls:', lifecycleCalls, '(sub id is the LOCAL id, not the blank one the provider returned)');

  // ── unknown_provider_ref — event references a providerRef with no local repo row ──
  const strayBody = JSON.stringify({ id: 'evt_stray', type: 'payment.succeeded', occurredAt: clock.now().toISOString(), subscriptionRef: 'sub_stripe_UNKNOWN', paymentRef: 'pi_UNKNOWN' });
  const strayOk = await receive({ provider, headers: { 'x-sig': 'ok' }, rawBody: strayBody, repo, clock });
  await processWebhook({ eventId: strayOk.eventId!, providers: { stripe: provider }, handlers, repo, clock });
  const strayRecord = await repo.webhookEvents.get(strayOk.eventId!);
  console.log('[unknown_provider_ref] record status:', strayRecord?.status, 'error:', strayRecord?.error, 'notifications:', JSON.stringify(notifications));

  // ── EC:F — Toss-like provider: nativeSubscriptions=false, getSubscription must not be called ──
  const tossSub: Subscription = { ...fixedSub, id: 'sub_2', providerRef: 'toss_sub_2', provider: 'toss' };
  const tossPayment: Payment = { ...fixedPayment, id: 'pay_2', providerRef: 'toss_pi_2', provider: 'toss', subscriptionId: tossSub.id };
  await repo.subscriptions.put(tossSub);
  await repo.payments.put(tossPayment);
  const tossBody = JSON.stringify({ id: 'evt_toss', type: 'payment.succeeded', occurredAt: clock.now().toISOString(), subscriptionRef: tossSub.providerRef, paymentRef: tossPayment.providerRef });
  const tossOk = await receive({ provider: tossProvider, headers: { 'x-sig': 'ok' }, rawBody: tossBody, repo, clock });
  await processWebhook({ eventId: tossOk.eventId!, providers: { toss: tossProvider }, handlers, repo, clock });
  const tossRecord = await repo.webhookEvents.get(tossOk.eventId!);
  console.log('[toss nativeSubscriptions=false] record status:', tossRecord?.status, '(no throw even though getSubscription() would have thrown)', 'lifecycle calls:', lifecycleCalls);

  // ── EC:E13 — getGrantsForCheckout polling helper ──
  const grants = await getGrantsForCheckout({ checkoutIdOrPaymentRef: fixedPayment.providerRef, repo, ledger: fakeLedger });
  console.log('[getGrantsForCheckout]', JSON.stringify(grants));

  console.log('\nsmoke: OK');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
