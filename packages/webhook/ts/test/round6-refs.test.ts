// Round-6 audit A6-1 (bp-audit6.md): a Stripe renewal is recorded under its invoice (in_…) while
// refund and dispute events name the PaymentIntent (pi_…). EC:E24 — the webhook resolves the event
// to the local payment (exact, alias, provider re-fetch) before refund/cs see it; an event that
// matches nothing tells a person once and fails the record instead of using customer 'unknown'.
import { describe, expect, it } from 'vitest';
import { CollectingNotifier, DEFAULT_POLICY, FixedClock, InMemoryLedger, InMemoryRepo, SequentialIdGen } from 'boilpayment-core';
import type { Customer, NormalizedEvent, Payment, Subscription } from 'boilpayment-core';
import { defaultHandlers, process as processWebhook, receive } from '../src/index.js';
import { FakeProvider, jsonVerify } from './helpers.js';

const period = { start: new Date('2026-03-01T00:00:00Z'), end: new Date('2026-04-01T00:00:00Z') };
const invoice = (aliases?: string[]): Payment => ({ id: 'in_1', customerId: '', provider: 'stripe', providerRef: 'in_1', subscriptionId: 'sub_123',
  amount: { amountMinor: 1999, currency: 'USD' }, status: 'succeeded', kind: 'subscription', period, occurredAt: period.start, failure: null, cashReceipt: null,
  ...(aliases ? { providerRefAliases: aliases } : {}) });
const intent = (withInvoice: boolean): Payment => ({ id: 'pi_1', customerId: '', provider: 'stripe', providerRef: 'pi_1', subscriptionId: null,
  amount: { amountMinor: 1999, currency: 'USD' }, status: 'refunded', kind: 'subscription', period: null, occurredAt: period.start, failure: null, cashReceipt: null,
  raw: { customer: 'cus_1' }, providerRefAliases: withInvoice ? ['in_1'] : [] });

function setup(opts: { invoiceAliases?: string[]; piKnowsInvoice?: boolean; knownCustomer?: boolean }) {
  const clock = new FixedClock(new Date('2026-03-05T00:00:00Z'));
  const repo = new InMemoryRepo(); const ledger = new InMemoryLedger(new SequentialIdGen('l_')); const notifier = new CollectingNotifier();
  const sub: Subscription = { id: 'sub_local', customerId: 'c1', planId: 'p', provider: 'stripe', providerRef: 'sub_123', status: 'active',
    currentPeriod: { start: new Date('2026-02-01T00:00:00Z'), end: period.start }, anchorDay: 1, cancelAtPeriodEnd: false, graceUntil: null,
    billingKey: null, scheduledPlanId: null, version: 0, createdAt: clock.now() };
  const provider = new FakeProvider({ name: 'stripe', verify: jsonVerify('stripe'),
    getPaymentImpl: (ref: string) => { if (ref === 'in_1') return invoice(opts.invoiceAliases); if (ref === 'pi_1') return intent(opts.piKnowsInvoice ?? false); throw new Error('no such payment'); },
    getSubscriptionImpl: () => ({ ...sub, currentPeriod: period }) });
  const refunds: NormalizedEvent[] = []; const disputes: NormalizedEvent[] = [];
  const handlers = defaultHandlers({ policy: DEFAULT_POLICY, ledger, repo, notifier, clock, ids: new SequentialIdGen('pay_'),
    lifecycle: { onRenewalPaid: async () => {}, dunning: { onPaymentFailed: async () => {} } },
    refund: { onExternalRefund: async (i) => { refunds.push(i.event); } },
    cs: { dispute: async (i) => { disputes.push(i.event); } } as never });
  const deliver = async (id: string, body: Record<string, unknown>) => {
    const r = await receive({ provider, headers: { 'x-sig': 'ok' }, rawBody: JSON.stringify({ id, occurredAt: clock.now().toISOString(), customerRef: null, subscriptionRef: null, ...body }), repo, clock });
    await processWebhook({ eventId: r.eventId!, providers: { stripe: provider }, handlers, repo, clock });
    return repo.webhookEvents.get(r.eventId!);
  };
  const init = async () => {
    await repo.subscriptions.put(sub);
    if (opts.knownCustomer !== false) await repo.customers.put({ id: 'c1', email: null, status: 'active', createdAt: clock.now(), providerRefs: [{ provider: 'stripe', ref: 'cus_1' }] } as Customer);
    await deliver('evt_paid', { type: 'payment.succeeded', subscriptionRef: 'sub_123', paymentRef: 'in_1' });
  };
  return { repo, notifier, refunds, disputes, deliver, init };
}

describe('EC:E24 refund/dispute events that name the PaymentIntent of an invoice-recorded renewal', () => {
  it('alias recorded with the renewal → refund reaches refund.onExternalRefund as the invoice', async () => {
    const t = setup({ invoiceAliases: ['pi_1', 'ch_1'] }); await t.init();
    const rec = await t.deliver('evt_re', { type: 'refund.created', paymentRef: 'pi_1', refundRef: 're_1', amount: { amountMinor: 1999, currency: 'USD' } });
    expect(rec?.status).toBe('processed');
    expect(t.refunds.map((e) => e.paymentRef)).toEqual(['in_1']);
  });

  it('dispute on the charge id resolves to the invoice too', async () => {
    const t = setup({ invoiceAliases: ['pi_1', 'ch_1'] }); await t.init();
    const rec = await t.deliver('evt_dp', { type: 'dispute.opened', paymentRef: 'ch_1' });
    expect(rec?.status).toBe('processed');
    expect(t.disputes.map((e) => e.paymentRef)).toEqual(['in_1']);
  });

  it('a row recorded before aliases existed is found through the provider (customer payments re-fetched)', async () => {
    const t2 = setup({ invoiceAliases: ['pi_1'] }); await t2.init();
    // a pre-upgrade row: no alias record points at it
    for (const op of await t2.repo.operations.list()) if (op.kind === 'payment.ref_alias') await t2.repo.operations.put({ ...op, result: { paymentId: 'gone' } });
    const rec = await t2.deliver('evt_re', { type: 'refund.created', paymentRef: 'pi_1', refundRef: 're_1', amount: { amountMinor: 1999, currency: 'USD' } });
    expect(rec?.status).toBe('processed');
    expect(t2.refunds.map((e) => e.paymentRef)).toEqual(['in_1']);
  });

  it('nothing matches → one needs_human notice, record failed, no refund call, no case for customer "unknown"', async () => {
    const t = setup({ knownCustomer: false }); await t.init();
    const a = await t.deliver('evt_re', { type: 'refund.created', paymentRef: 'pi_9', refundRef: 're_9', amount: { amountMinor: 1999, currency: 'USD' } });
    expect(a?.status).toBe('failed');
    expect(a?.error).toMatch(/names no local payment/);
    await t.deliver('evt_re', { type: 'refund.created', paymentRef: 'pi_9', refundRef: 're_9', amount: { amountMinor: 1999, currency: 'USD' } });
    expect(t.refunds).toEqual([]);
    expect(t.notifier.sent.filter((n) => n.type === 'cs.needs_human' && n.payload.kind === 'unmatched_refund')).toHaveLength(1);
    expect(await t.repo.csCases.list()).toEqual([]);
  });
});
