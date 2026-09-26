// EC:B18 — chargeback evidence workflow. Mirrors packages/cs/py/tests/test_evidence.py (same cases).
// See docs/EDGE_CASES.md B18, packages/cs/spec/cs.pseudo.md [EC:B18].
import { describe, expect, it, beforeEach } from 'vitest';
import {
  DEFAULT_POLICY, FixedClock, InMemoryLedger, InMemoryRepo, SequentialIdGen, CollectingNotifier,
  resolvePolicy,
} from '@schift/payment-kit-core';
import type { Customer, Payment, Policy } from '@schift/payment-kit-core';
import { openCase } from '../src/index.js';
import { checklist, collect, due, submit } from '../src/evidence.js';

let clock: FixedClock;
let ids: SequentialIdGen;
let repo: InMemoryRepo;
let ledger: InMemoryLedger;
let notifier: CollectingNotifier;
let policy: Policy;
const customerId = 'cust_ev';

beforeEach(() => {
  clock = new FixedClock(new Date('2026-01-01T00:00:00Z'));
  ids = new SequentialIdGen('id_');
  repo = new InMemoryRepo();
  ledger = new InMemoryLedger(ids);
  notifier = new CollectingNotifier();
  policy = DEFAULT_POLICY;
});

async function putCustomer(): Promise<Customer> {
  const c: Customer = { id: customerId, email: `${customerId}@x.com`, providerRefs: [{ provider: 'stripe', ref: 'cus_ev' }], status: 'active', createdAt: clock.now() };
  await repo.customers.put(c);
  return c;
}

async function putPayment(id = 'pay_ev'): Promise<Payment> {
  const p: Payment = {
    id, customerId, provider: 'stripe', providerRef: `pi_${id}`, subscriptionId: null,
    amount: { amountMinor: 5000, currency: 'USD' }, status: 'disputed', kind: 'topup', period: null,
    occurredAt: clock.now(), failure: null, cashReceipt: null,
  };
  await repo.payments.put(p);
  return p;
}

async function openDisputeCase(pol: Policy = policy) {
  await putCustomer();
  return openCase({ customerId, kind: 'dispute', referenceId: 'pi_ev', policy: pol, repo, clock, ids });
}

describe('cs.evidence.checklist', () => {
  it('[EC:B18] marks ledger-backed items available and unknown ones unavailable-with-reason', async () => {
    const csCase = await openDisputeCase();
    const payment = await putPayment();
    const { entry: grant } = await ledger.append({
      customerId, pool: 'paid', kind: 'grant', amount: 100, unitPriceMinor: 10, currency: 'USD', expiresAt: null,
      source: 'topup', reference: { paymentId: payment.id }, idempotencyKey: `topup:${payment.id}`, actor: 'system', reason: null,
    });
    await ledger.append({
      customerId, pool: 'paid', kind: 'consume', amount: -30, unitPriceMinor: null, currency: null, expiresAt: null,
      source: 'usage', reference: { grantId: grant.id }, idempotencyKey: 'consume:1', actor: 'system', reason: null,
    });

    const items = await checklist({ case: csCase, payment, sub: null, repo, ledger, policy, clock });
    const byKey = Object.fromEntries(items.map((i) => [i.key, i]));

    expect(byKey.payment_record.available).toBe(true);
    expect(byKey.proof_of_delivery.available).toBe(true);
    expect(byKey.proof_of_usage.available).toBe(true);
    expect(byKey.case_trail.available).toBe(true); // always available — falls back to case fields

    // Honest gaps: the kit genuinely has none of these.
    expect(byKey.customer_acceptance.available).toBe(false);
    expect(byKey.customer_acceptance.reason).toBeTruthy();
    expect(byKey.usage_events.available).toBe(false); // no `sub` passed
    expect(byKey.usage_events.reason).toBeTruthy();
    expect(byKey.refund_communication.available).toBe(false); // no refunds recorded
    expect(byKey.refund_communication.reason).toBeTruthy();
  });

  it('[EC:B18] with no payment record, payment/grant/consume items are all unavailable with reasons', async () => {
    const csCase = await openDisputeCase();
    const items = await checklist({ case: csCase, payment: null, sub: null, repo, ledger, policy, clock });
    const byKey = Object.fromEntries(items.map((i) => [i.key, i]));
    expect(byKey.payment_record.available).toBe(false);
    expect(byKey.proof_of_delivery.available).toBe(false);
    expect(byKey.proof_of_usage.available).toBe(false);
    for (const i of items) if (!i.available) expect(i.reason).toBeTruthy();
  });
});

describe('cs.evidence.collect', () => {
  it('[EC:B18] is idempotent — repeated calls refresh the checklist without duplicate side effects', async () => {
    const csCase = await openDisputeCase();
    const payment = await putPayment();

    const first = await collect({ case: csCase, payment, sub: null, repo, ledger, policy, clock });
    const firstRecord = (first.decision as any).evidence;
    expect(firstRecord.items.length).toBeGreaterThan(0);
    expect(firstRecord.dueAt).toBeTruthy();
    expect(firstRecord.collectedAt).toBeTruthy();

    const second = await collect({ case: csCase, payment, sub: null, repo, ledger, policy, clock });
    const secondRecord = (second.decision as any).evidence;
    expect(secondRecord.items.length).toBe(firstRecord.items.length);

    // No ledger writes happen as a side effect of collecting.
    expect((await ledger.entries(customerId)).length).toBe(0);
  });
});

describe('cs.evidence.submit', () => {
  it('[EC:B18] against a provider without submitDisputeEvidence returns submitted:false and escalates', async () => {
    const csCase = await openDisputeCase();
    const payment = await putPayment();
    const provider = {}; // no submitDisputeEvidence — e.g. Toss/PortOne

    const result = await submit({ case: csCase, payment, sub: null, provider, repo, ledger, policy, clock, notifier });

    expect(result.submitted).toBe(false);
    expect(result.reason).toBe('provider_unsupported');
    expect(result.case.status).toBe('needs_human');
    expect(notifier.sent.some((n) => n.type === 'cs.needs_human')).toBe(true);
  });

  it('[EC:B18] against a provider WITH submitDisputeEvidence returns submitted:true and records providerRef', async () => {
    const csCase = await openDisputeCase();
    const payment = await putPayment();
    const provider = {
      async submitDisputeEvidence(input: { paymentRef: string; caseId: string; evidence: unknown[] }) {
        expect(input.paymentRef).toBe(payment.providerRef);
        return { providerRef: 'stripe_evd_1' };
      },
    };

    const result = await submit({ case: csCase, payment, sub: null, provider, repo, ledger, policy, clock, notifier });
    expect(result.submitted).toBe(true);
    expect(result.providerRef).toBe('stripe_evd_1');
    expect(((result.case.decision as any).evidence).submittedAt).toBeTruthy();
  });

  it('[EC:B18] never pretends success when the provider throws', async () => {
    const csCase = await openDisputeCase();
    const payment = await putPayment();
    const provider = { async submitDisputeEvidence() { throw new Error('network down'); } };

    const result = await submit({ case: csCase, payment, sub: null, provider, repo, ledger, policy, clock, notifier });
    expect(result.submitted).toBe(false);
    expect(result.reason).toBe('submit_failed');
    expect(result.case.status).toBe('needs_human');
  });
});

describe('cs.evidence.due', () => {
  it('[EC:B18] escalates only once the case is inside 24h of its evidence deadline', async () => {
    const pol = resolvePolicy({ dispute: { evidenceDueDays: 7 } });
    const csCase = await openDisputeCase(pol);
    // No evidence collected -> incomplete throughout.

    const farFromDeadline = await due({ repo, clock, notifier });
    expect(farFromDeadline).toHaveLength(0);
    expect(notifier.sent).toHaveLength(0); // 7 days out — nothing to escalate yet

    clock.advance(7 * 24 * 60 * 60 * 1000 - 60 * 60 * 1000); // 1h from the 7-day deadline
    const insideWindow = await due({ repo, clock, notifier });
    expect(insideWindow).toHaveLength(1);
    expect(insideWindow[0].case.id).toBe(csCase.id);
    expect(insideWindow[0].incomplete).toBe(true);
  });

  it('[EC:B18] does not escalate a case whose evidence is already complete', async () => {
    const pol = resolvePolicy({ dispute: { evidenceDueDays: 7 } });
    const csCase = await openDisputeCase(pol);
    const payment = await putPayment();
    // Complete every required item by hand so `incomplete` is false regardless of real-world gaps
    // like customer_acceptance (which is always unavailable) — this test is about the due()
    // cutoff, not checklist completeness.
    const items = (await checklist({ case: csCase, payment, sub: null, repo, ledger, policy: pol, clock }))
      .map((i) => ({ ...i, available: true }));
    csCase.decision = { evidence: { items, dueAt: new Date(csCase.openedAt.getTime() + 7 * 86_400_000).toISOString(), collectedAt: clock.now().toISOString() } };
    await repo.csCases.put(csCase);

    clock.advance(7 * 24 * 60 * 60 * 1000 - 60 * 60 * 1000);
    const result = await due({ repo, clock, notifier });
    expect(result).toHaveLength(0);
  });
});
