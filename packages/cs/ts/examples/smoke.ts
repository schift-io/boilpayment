// Smoke test — real code path through cs's own modules. `refund.evaluate`/`refund.execute` are
// imported from the sibling package by relative path (cs has no workspace dependency on
// boilpayment-refund — see ARCHITECTURE.md "새 의존성이 필요하면 ... 우회한다" and the final
// report's "계약 변경 제안"). Run: node <tsx> packages/cs/ts/examples/smoke.ts
import {
  Customer, DEFAULT_POLICY, FixedClock, InMemoryLedger, InMemoryRepo, NormalizedEvent, Payment,
  PaymentKitError, PaymentProvider, Policy, Refund, SequentialIdGen,
} from 'boilpayment-core';
import { evaluate as refundEvaluate, execute as refundExecute } from '../../../refund/ts/src/index.js';
import {
  dispute, explain, HttpLicenseReporter, Metrics, openCase, reconcile, refundAssist, regrant, settlementReport, timeline, widget,
} from '../src/index.js';

// ── EC:I5 fake HTTP server for HttpLicenseReporter — records requests, can be told to fail once ──
interface RecordedCall { url: string; method: string; headers: Record<string, string>; body: unknown }
const httpCalls: RecordedCall[] = [];
let failNextCall = false;
const fakeFetch = (async (input: string | URL, init?: RequestInit) => {
  const headers: Record<string, string> = {};
  if (init?.headers) for (const [k, v] of Object.entries(init.headers as Record<string, string>)) headers[k] = v;
  httpCalls.push({ url: String(input), method: init?.method ?? 'GET', headers, body: init?.body ? JSON.parse(String(init.body)) : null });
  if (failNextCall) {
    failNextCall = false;
    return new Response('server error', { status: 500 });
  }
  if (String(input).endsWith('/entitlement')) {
    return new Response(JSON.stringify({ tier: 'pro', includedCasesPerMonth: 500, usedThisMonth: 12, overagePriceMinor: 500, currency: 'USD', hardLimit: false }), { status: 200 });
  }
  return new Response(JSON.stringify({ ok: true }), { status: 200 });
}) as unknown as typeof fetch;
const licenseReporter = new HttpLicenseReporter({ apiKey: 'test-api-key', fetch: fakeFetch });

const ids = new SequentialIdGen('id_');
const clock = new FixedClock(new Date('2026-02-01T00:00:00Z'));
const ledger = new InMemoryLedger(ids);
const repo = new InMemoryRepo();
const metrics = new Metrics();
const policy: Policy = DEFAULT_POLICY;

class FakeProvider implements PaymentProvider {
  readonly name = 'stripe' as const;
  capabilities() { return { nativeSubscriptions: true, partialRefund: true, meters: false, scheduling: 'provider' as const, webhookSignature: true }; }
  async createCustomer() { return { ref: 'cus_fake' }; }
  async createCheckout(): Promise<never> { throw new Error('unused'); }
  async getPayment(): Promise<never> { throw new Error('unused'); }
  async listPayments(): Promise<Payment[]> { return [subPayment, topupPaymentMissingGrant]; }
  async getSubscription(): Promise<never> { throw new Error('unused'); }
  async changeSubscription(): Promise<never> { throw new Error('unused'); }
  async cancelSubscription(): Promise<never> { throw new Error('unused'); }
  async chargeBillingKey(): Promise<never> { throw new Error('unused'); }
  async refund(input: { paymentRef: string; amount: { amountMinor: number; currency: string } }): Promise<Refund> {
    return {
      id: `cancel_${input.paymentRef}`, paymentId: 'unused', customerId: '', amount: input.amount, status: 'succeeded',
      providerRef: `pref_${input.paymentRef}`, creditsRevoked: 0, ruleId: '', reason: null, failure: null,
      createdAt: new Date(),
    };
  }
  async reportUsage() {}
  async verifyWebhook(): Promise<never> { throw new Error('unused'); }
}
const provider = new FakeProvider();

// EC:D13 — Toss virtual-account refund missing extra.refundReceiveAccount.
class ReceiveAccountRequiredProvider extends FakeProvider {
  async refund(): Promise<never> {
    throw new PaymentKitError('refundReceiveAccount required for Toss virtual account refunds', 'refund_receive_account_required');
  }
}

const customerId = 'cust_2';
const customer: Customer = {
  id: customerId, email: 'cust2@example.com', providerRefs: [{ provider: 'stripe', ref: 'cus_stripe_2' }],
  status: 'active', createdAt: clock.now(),
};

const subPeriodStart = new Date('2026-01-01T00:00:00Z');
const subPayment: Payment = {
  id: 'pay_sub_1', customerId, provider: 'stripe', providerRef: 'pi_sub_1', subscriptionId: 'sub_1',
  amount: { amountMinor: 2000, currency: 'USD' }, status: 'succeeded', kind: 'subscription',
  period: { start: subPeriodStart, end: new Date('2026-02-01T00:00:00Z') }, occurredAt: subPeriodStart, failure: null,
};
const topupPaymentMissingGrant: Payment = {
  id: 'pay_topup_1', customerId, provider: 'stripe', providerRef: 'pi_topup_1', subscriptionId: null,
  amount: { amountMinor: 1000, currency: 'USD' }, status: 'succeeded', kind: 'topup', period: null,
  occurredAt: clock.now(), failure: null,
};

async function main() {
  await repo.customers.put(customer);
  await repo.payments.put(subPayment);
  await repo.payments.put(topupPaymentMissingGrant);

  // subPayment's grant WAS applied correctly — pre-seed the ledger so reconcile skips it.
  const subGrantKey = `grant:sub_1:${subPeriodStart.toISOString()}`;
  await ledger.append({
    customerId, pool: 'paid', kind: 'grant', amount: 200, unitPriceMinor: 10, currency: 'USD', expiresAt: null,
    source: 'subscription', reference: { subscriptionId: 'sub_1', periodStart: subPeriodStart },
    idempotencyKey: subGrantKey, actor: 'system', reason: null,
  });

  // ── EC:E1 reconcile — topupPaymentMissingGrant has no matching ledger grant ──
  const cases = await reconcile({ providers: { stripe: provider }, ledger, repo, policy, clock, ids, since: new Date('2026-01-01T00:00:00Z'), onCaseEvent: metrics.record });
  console.log('[reconcile] opened cases:', cases.map((c) => ({ id: c.id, kind: c.kind, referenceId: c.referenceId, status: c.status })));

  // ── EC:A18/E1/E2/E14 regrant — auto mode replays the missing grant with the ORIGINAL idempotency key ──
  const missingCase = cases[0];
  const regranted = await regrant({
    case: missingCase, ledger, repo, policy, clock, ids,
    plan: { pool: 'paid', amount: 50, unitPriceMinor: 20, currency: 'USD', reason: 'reconcile: missing topup grant' },
    onCaseEvent: metrics.record,
  });
  const balanceAfterRegrant = await ledger.balance(customerId, 'paid', clock.now());
  console.log('\n[regrant] case status:', regranted.status, 'decision:', regranted.decision, 'balance after:', balanceAfterRegrant.available);

  // E14 — a late-arriving duplicate regrant (e.g. the original webhook finally shows up) must no-op.
  const regrantedAgain = await regrant({
    case: missingCase, ledger, repo, policy, clock, ids,
    plan: { pool: 'paid', amount: 50, unitPriceMinor: 20, currency: 'USD' },
    onCaseEvent: metrics.record,
  });
  console.log('[regrant again, E14 no-op] decision:', regrantedAgain.decision, 'balance unchanged:', (await ledger.balance(customerId, 'paid', clock.now())).available);

  // ── EC:D*/I1/I2 refundAssist — evaluate/execute injected from the refund package ──
  const refundPayment: Payment = {
    id: 'pay_refundassist_1', customerId, provider: 'stripe', providerRef: 'pi_ra_1', subscriptionId: null,
    amount: { amountMinor: 500, currency: 'USD' }, status: 'succeeded', kind: 'topup', period: null,
    occurredAt: clock.now(), failure: null,
  };
  await repo.payments.put(refundPayment);
  await ledger.append({
    customerId, pool: 'paid', kind: 'grant', amount: 25, unitPriceMinor: 20, currency: 'USD', expiresAt: null,
    source: 'topup', reference: { paymentId: refundPayment.id }, idempotencyKey: `topup:${refundPayment.id}`, actor: 'system', reason: null,
  });
  const refundCase = await openCase({ customerId, kind: 'refund', referenceId: refundPayment.id, policy, repo, clock, ids, onCaseEvent: metrics.record });
  const assistedCase = await refundAssist({
    case: refundCase, payment: refundPayment, policy, ledger, repo, clock, ids, provider,
    refundEvaluate, refundExecute, churnReason: 'not_using', churnText: 'switched to a competitor', onCaseEvent: metrics.record,
    reporter: licenseReporter, // EC:I5
  });
  console.log('\n[refundAssist] case status:', assistedCase.status, 'decision:', JSON.stringify(assistedCase.decision));
  console.log('[refundAssist] churn recorded on case:', assistedCase.churnReason, '-', assistedCase.churnText);

  // ── EC:I5 — one resolved case -> exactly one POST /cases with a bearer header ──
  console.log('\n[license] POST /cases calls so far:', httpCalls.length);
  console.log('[license] last call:', httpCalls[httpCalls.length - 1].method, httpCalls[httpCalls.length - 1].url, 'auth:', httpCalls[httpCalls.length - 1].headers.Authorization, 'body:', JSON.stringify(httpCalls[httpCalls.length - 1].body));

  // ── EC:D12/D13 refundAssist against a Toss-style provider missing refundReceiveAccount ──
  const tossPayment: Payment = {
    id: 'pay_toss_1', customerId, provider: 'toss', providerRef: 'pi_toss_1', subscriptionId: null,
    amount: { amountMinor: 10000, currency: 'KRW' }, status: 'succeeded', kind: 'topup', period: null,
    occurredAt: clock.now(), failure: null,
  };
  await repo.payments.put(tossPayment);
  await ledger.append({
    customerId, pool: 'paid', kind: 'grant', amount: 1000, unitPriceMinor: 10, currency: 'KRW', expiresAt: null,
    source: 'topup', reference: { paymentId: tossPayment.id }, idempotencyKey: `topup:${tossPayment.id}`, actor: 'system', reason: null,
  });
  const tossCase = await openCase({ customerId, kind: 'refund', referenceId: tossPayment.id, policy, repo, clock, ids, onCaseEvent: metrics.record });
  // EC:I5 — unresolved refunds must not report a billable resolution.
  const licenseReporterWithOutbox = new HttpLicenseReporter({ apiKey: 'test-api-key', fetch: fakeFetch, repo });
  const tossAssistedCase = await refundAssist({
    case: tossCase, payment: tossPayment, policy, ledger, repo, clock, ids, provider: new ReceiveAccountRequiredProvider(),
    refundEvaluate, refundExecute, onCaseEvent: metrics.record,
    reporter: licenseReporterWithOutbox, // EC:I5
  });
  const tossDecision = tossAssistedCase.decision as { refund: { id: string; status: string } };
  console.log('\n[refundAssist, EC:D13] original case status:', tossAssistedCase.status, 'refund status:', tossDecision.refund.status);
  const [refundFailedCase] = await repo.csCases.list({ kind: 'refund_failed', referenceId: tossDecision.refund.id });
  console.log('[refundAssist, EC:D13] refund_failed case status:', refundFailedCase.status, 'decision:', refundFailedCase.decision);
  console.log('[license, EC:I5] unresolved case is not billable; queue remains empty.');
  const outboxAfterFailure = await repo.outbox.list({ kind: 'cs.license' });
  console.log('[license, EC:I5] repo.outbox for unresolved case:', outboxAfterFailure.map((o) => ({ id: o.id, kind: o.kind, status: o.status })));
  const flushResult = await licenseReporterWithOutbox.flush();
  console.log('[license, EC:I5] flush() after server recovers:', flushResult);
  const outboxAfterFlush = await repo.outbox.list({ kind: 'cs.license' });
  console.log('[license, EC:I5] repo.outbox after flush:', outboxAfterFlush.map((o) => ({ id: o.id, kind: o.kind, status: o.status })));

  // ── EC:B11/D9 dispute — dispute.opened freezes the customer per default policy ──
  const disputeEvent: NormalizedEvent = {
    id: 'evt_dispute_1', provider: 'stripe', type: 'dispute.opened', occurredAt: clock.now(),
    customerRef: null, subscriptionRef: null, paymentRef: refundPayment.providerRef, amount: null, raw: null,
  };
  const disputeCase = await dispute({ event: disputeEvent, policy, ledger, repo, notifier: { send: async (n) => console.log('[notifier]', n.type, n.payload) }, clock, ids, onCaseEvent: metrics.record });
  const customerAfter = await repo.customers.get(customerId);
  console.log('\n[dispute] case status:', disputeCase.status, 'customer status:', customerAfter?.status);

  // ── EC:I9 timeline — reconstruct the customer's evidence trail from repo/ledger alone ──
  const customerTimeline = await timeline({ customerId, repo, ledger, clock });
  console.log('\n[timeline, EC:I9] event kinds:', customerTimeline.events.map((e) => e.kind));
  console.log('[timeline, EC:I9] explain():');
  for (const line of explain(customerTimeline.events)) console.log('  -', line);
  const paymentTimeline = await timeline({ paymentId: refundPayment.id, repo, ledger, clock });
  console.log('[timeline, EC:I9] paymentId-scoped event count:', paymentTimeline.events.length, 'truncated:', paymentTimeline.truncated);

  // ── EC:I6 widget ──
  const fixedNow = new Date(1_700_000_000_000); // deterministic exp so ts/py smokes are comparable
  const token = widget.signToken({ customerId, ttlSeconds: 3600, now: fixedNow }, 'test-secret');
  const claims = widget.verifyToken(token, 'test-secret', { now: fixedNow });
  console.log('\n[widget] round-trip claims:', claims);

  // ── EC:I5 entitlement — asks the server, never computes price locally ──
  const entitlement = await licenseReporter.entitlement();
  console.log('\n[license, EC:I5] entitlement:', entitlement);

  // ── metrics snapshot ──
  console.log('\n[metrics] snapshot:', JSON.stringify(metrics.snapshot(), null, 2));

  // EC:I10 — settlement report on its own fixture
  const sClock = new FixedClock(new Date('2026-01-10T00:00:00Z'));
  const sRepo = new InMemoryRepo(); const sLedger = new InMemoryLedger(new SequentialIdGen('s_'), sClock);
  await sRepo.customers.put({ id: 'sc', email: null, providerRefs: [], status: 'active', createdAt: sClock.now() });
  await sRepo.payments.put({ id: 'sp1', customerId: 'sc', provider: 'stripe', providerRef: 'pi_s1', subscriptionId: null, amount: { amountMinor: 1000, currency: 'USD' }, status: 'succeeded', kind: 'topup', period: null, occurredAt: sClock.now(), failure: null });
  await sRepo.payments.put({ id: 'sp2', customerId: 'sc', provider: 'toss', providerRef: 'pi_s2', subscriptionId: null, amount: { amountMinor: 9900, currency: 'KRW' }, status: 'succeeded', kind: 'topup', period: null, occurredAt: sClock.now(), failure: null });
  await sRepo.refunds.put({ id: 'sr1', paymentId: 'sp1', customerId: 'sc', amount: { amountMinor: 300, currency: 'USD' }, status: 'succeeded', providerRef: 're_s1', creditsRevoked: 0, ruleId: 'D2', reason: null, failure: null, createdAt: sClock.now() });
  await sLedger.append({ customerId: 'sc', pool: 'paid', kind: 'grant', amount: 100, unitPriceMinor: 10, currency: 'USD', expiresAt: null, source: 'topup', reference: {}, idempotencyKey: 'sg', actor: 's', reason: null });
  const rep = await settlementReport({ repo: sRepo, ledger: sLedger, from: new Date('2026-01-01T00:00:00Z'), to: new Date('2026-02-01T00:00:00Z') });
  console.log('[settlement I10] net:', rep.net.map((n) => `${n.currency}=${n.amountMinor}`).join(','), 'refunds:', rep.refunds.map((r) => `${r.currency}x${r.count}=${r.amountMinor}`).join(','), 'credits:', rep.credits.map((c) => `${c.kind}/${c.source}=${c.amount}`).join(','));

  console.log('\nsmoke: OK');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
