// Phase 6 regression tests — packages/cs (TS). Real code paths against the core in-memory
// doubles; PaymentProvider and fetch are faked. Mirrors packages/cs/py/tests/test_cs.py
// (same cases). See docs/EDGE_CASES.md I1-I8/A18/E1/E2/E14/B11/D9, packages/cs/spec/cs.pseudo.md.
import { describe, it, expect, beforeEach } from 'vitest';
import {
  DEFAULT_POLICY, FixedClock, InMemoryRepo, InMemoryLedger, SequentialIdGen, CollectingNotifier,
  resolvePolicy,
} from '@schift/payment-kit-core';
import type {
  Customer, CsCase, NormalizedEvent, Payment, PaymentProvider, ProviderCapabilities, Policy, Refund,
} from '@schift/payment-kit-core';
import {
  openCase, escalate, resolve, reject, regrant, reconcile, dispute, churn, widget,
  Metrics, CaseMeter, HttpLicenseReporter,
} from '../src/index.js';
import type { LicenseReporter, CaseReportInput } from '../src/metrics.js';

let clock: FixedClock;
let ids: SequentialIdGen;
let repo: InMemoryRepo;
let ledger: InMemoryLedger;
let notifier: CollectingNotifier;
let policy: Policy;
const customerId = 'cust_1';

beforeEach(() => {
  clock = new FixedClock(new Date('2026-01-01T00:00:00Z'));
  ids = new SequentialIdGen('id_');
  repo = new InMemoryRepo();
  ledger = new InMemoryLedger(ids);
  notifier = new CollectingNotifier();
  policy = DEFAULT_POLICY;
});

async function putCustomer(id = customerId, status: Customer['status'] = 'active'): Promise<Customer> {
  const c: Customer = { id, email: `${id}@x.com`, providerRefs: [{ provider: 'stripe', ref: `cus_${id}` }], status, createdAt: clock.now() };
  await repo.customers.put(c);
  return c;
}

describe('cs.openCase', () => {
  it('[EC:I7] dedupes (customerId, kind, referenceId) while status is active', async () => {
    const first = await openCase({ customerId, kind: 'refund', referenceId: 'ref_1', policy, repo, clock, ids });
    const second = await openCase({ customerId, kind: 'refund', referenceId: 'ref_1', policy, repo, clock, ids });
    expect(second.id).toBe(first.id);
    const all = await repo.csCases.list({ customerId, kind: 'refund', referenceId: 'ref_1' });
    expect(all).toHaveLength(1);
  });

  it('[EC:I7] a new case is opened once the prior one is resolved', async () => {
    const first = await openCase({ customerId, kind: 'refund', referenceId: 'ref_2', policy, repo, clock, ids });
    await resolve({ case: first, by: 'auto', decision: {}, repo, clock });
    const second = await openCase({ customerId, kind: 'refund', referenceId: 'ref_2', policy, repo, clock, ids });
    expect(second.id).not.toBe(first.id);
  });

  it('[EC:I8] stores a policy snapshot at open time that later policy changes do not affect', async () => {
    const openedPolicy = resolvePolicy({ refund: { noQuestionsDays: 3 } });
    const csCase = await openCase({ customerId, kind: 'refund', referenceId: 'ref_3', policy: openedPolicy, repo, clock, ids });
    expect(csCase.policySnapshot.refund.noQuestionsDays).toBe(3);

    openedPolicy.refund.noQuestionsDays = 99;
    const laterPolicy = resolvePolicy({ refund: { noQuestionsDays: 30 } });
    // Using a different policy object elsewhere must not mutate the already-open case's snapshot.
    await openCase({ customerId: 'cust_other', kind: 'refund', referenceId: 'ref_3b', policy: laterPolicy, repo, clock, ids });
    const reread = await repo.csCases.get(csCase.id);
    expect(reread!.policySnapshot.refund.noQuestionsDays).toBe(3);
  });
});

describe('cs.escalate', () => {
  it('[EC:I3] moves the case to needs_human and notifies cs.needs_human', async () => {
    const csCase = await openCase({ customerId, kind: 'dispute', referenceId: 'ref_esc', policy, repo, clock, ids });
    const escalated = await escalate({ case: csCase, repo, clock, reason: 'manual review needed', notifier });
    expect(escalated.status).toBe('needs_human');
    expect(notifier.sent).toHaveLength(1);
    expect(notifier.sent[0]).toMatchObject({
      type: 'cs.needs_human', customerId,
      payload: { caseId: csCase.id, kind: 'dispute', reason: 'manual review needed' },
    });
  });
});

describe('cs.resolve / cs.reject — EC:I5 license reporting', () => {
  class RecordingReporter implements LicenseReporter {
    calls: CaseReportInput[] = [];
    async reportCase(input: CaseReportInput) { this.calls.push(input); }
    async entitlement() { return null; }
    async heartbeat() {}
  }

  it('[EC:I5] resolve() reports the resolved_auto transition exactly once', async () => {
    const csCase = await openCase({ customerId, kind: 'refund', referenceId: 'r1', policy, repo, clock, ids });
    const reporter = new RecordingReporter();
    const resolved = await resolve({ case: csCase, by: 'auto', decision: { ok: true }, repo, clock, reporter });
    expect(resolved.status).toBe('resolved_auto');
    expect(reporter.calls).toHaveLength(1);
    expect(reporter.calls[0]).toMatchObject({ caseId: csCase.id, kind: 'refund', status: 'resolved_auto', tenantRef: customerId });
  });

  it('[EC:I5] reject() reports the rejected transition exactly once', async () => {
    const csCase = await openCase({ customerId, kind: 'refund', referenceId: 'r2', policy, repo, clock, ids });
    const reporter = new RecordingReporter();
    const rejected = await reject({ case: csCase, reason: 'ineligible', repo, clock, reporter });
    expect(rejected.status).toBe('rejected');
    expect(reporter.calls).toHaveLength(1);
    expect(reporter.calls[0].status).toBe('rejected');
  });
});

describe('cs.regrant', () => {
  it('[EC:A18/E1] auto mode grants credits and resolves resolved_auto', async () => {
    const csCase = await openCase({ customerId, kind: 'regrant', referenceId: 'topup:pay_x', policy, repo, clock, ids });
    const resolved = await regrant({ case: csCase, ledger, repo, policy, clock, ids, plan: { pool: 'paid', amount: 50, reason: 'reconcile regrant' } });
    expect(resolved.status).toBe('resolved_auto');
    const decision = resolved.decision as { granted: boolean; entryId: string; idempotencyKey: string };
    expect(decision.granted).toBe(true);
    expect(decision.idempotencyKey).toBe('topup:pay_x'); // defaults to case.referenceId
    expect((await ledger.balance(customerId, 'paid', clock.now())).available).toBe(50);
  });

  it('[EC:E2/E14/J1] a duplicate regrant with the same idempotency key is a no-op grant but still resolves', async () => {
    const csCase = await openCase({ customerId, kind: 'regrant', referenceId: 'topup:pay_y', policy, repo, clock, ids });
    const first = await regrant({ case: csCase, ledger, repo, policy, clock, ids, plan: { pool: 'paid', amount: 50 } });
    const decision1 = first.decision as { granted: boolean };
    expect(decision1.granted).toBe(true);

    // simulate a late-arriving duplicate webhook re-driving the same case/plan. EC:J1 — regrant() is
    // wrapped in runIdempotent keyed by the same idempotency key used for the ledger append, so the
    // second call never reaches the ledger at all: it replays the first call's CsCase/decision verbatim.
    const second = await regrant({ case: first, ledger, repo, policy, clock, ids, plan: { pool: 'paid', amount: 50 } });
    const decision2 = second.decision as { granted: boolean };
    expect(decision2.granted).toBe(true); // replayed first decision, not a fresh (deduped) append
    expect(second.status).toBe('resolved_auto');
    expect((await ledger.balance(customerId, 'paid', clock.now())).available).toBe(50); // not double-granted
  });

  it('[EC:A18] manual_approve without approvedBy escalates to needs_human', async () => {
    const pol = resolvePolicy({ cs: { regrant: { mode: 'manual_approve' } } });
    const csCase = await openCase({ customerId, kind: 'regrant', referenceId: 'topup:pay_z', policy: pol, repo, clock, ids });
    const result = await regrant({ case: csCase, ledger, repo, policy: pol, clock, ids, plan: { pool: 'paid', amount: 50 } });
    expect(result.status).toBe('needs_human');
    expect((await ledger.balance(customerId, 'paid', clock.now())).available).toBe(0);
  });

  it('[EC:A18] manual_approve with approvedBy grants and resolves resolved_auto', async () => {
    const pol = resolvePolicy({ cs: { regrant: { mode: 'manual_approve' } } });
    const csCase = await openCase({ customerId, kind: 'regrant', referenceId: 'topup:pay_w', policy: pol, repo, clock, ids });
    const result = await regrant({ case: csCase, ledger, repo, policy: pol, clock, ids, plan: { pool: 'paid', amount: 50 }, approvedBy: 'agent_42' });
    expect(result.status).toBe('resolved_auto');
    const decision = result.decision as { approvedBy: string | null };
    expect(decision.approvedBy).toBe('agent_42');
  });

  it('[EC:A18] off mode rejects without granting', async () => {
    const pol = resolvePolicy({ cs: { regrant: { mode: 'off' } } });
    const csCase = await openCase({ customerId, kind: 'regrant', referenceId: 'topup:pay_v', policy: pol, repo, clock, ids });
    const result = await regrant({ case: csCase, ledger, repo, policy: pol, clock, ids, plan: { pool: 'paid', amount: 50 } });
    expect(result.status).toBe('rejected');
    expect((await ledger.balance(customerId, 'paid', clock.now())).available).toBe(0);
  });

  it('[EC:L5] auto mode stamps correlationId on the grant entry', async () => {
    const csCase = await openCase({ customerId, kind: 'regrant', referenceId: 'topup:pay_l5', policy, repo, clock, ids });
    const resolved = await regrant({
      case: csCase, ledger, repo, policy, clock, ids, plan: { pool: 'paid', amount: 50 }, correlationId: 'corr_regrant_1',
    });
    expect(resolved.status).toBe('resolved_auto');
    const entries = await ledger.entries(customerId, { kind: 'grant' });
    const entry = entries.find((e) => e.source === 'regrant');
    expect(entry?.reference.correlationId).toBe('corr_regrant_1');
  });
});

describe('cs.reconcile', () => {
  class FakeProvider implements PaymentProvider {
    readonly name = 'stripe' as const;
    constructor(private readonly payments: Payment[]) {}
    capabilities(): ProviderCapabilities { return { nativeSubscriptions: true, partialRefund: true, meters: false, scheduling: 'provider', webhookSignature: true }; }
    async createCustomer(): Promise<{ ref: string }> { throw new Error('unused'); }
    async createCheckout(): Promise<never> { throw new Error('unused'); }
    async getPayment(): Promise<never> { throw new Error('unused'); }
    async listPayments(): Promise<Payment[]> { return this.payments; }
    async getSubscription(): Promise<never> { throw new Error('unused'); }
    async changeSubscription(): Promise<never> { throw new Error('unused'); }
    async cancelSubscription(): Promise<never> { throw new Error('unused'); }
    async chargeBillingKey(): Promise<never> { throw new Error('unused'); }
    async refund(): Promise<never> { throw new Error('unused'); }
    async reportUsage() {}
    async verifyWebhook(): Promise<never> { throw new Error('unused'); }
  }

  it('[EC:E1] flags an unmatched topup payment as a regrant case, [EC:E14] second pass is a no-op once regranted', async () => {
    await putCustomer();
    const topup: Payment = {
      id: 'pay_topup', customerId, provider: 'stripe', providerRef: 'pi_topup', subscriptionId: null,
      amount: { amountMinor: 500, currency: 'USD' }, status: 'succeeded', kind: 'topup', period: null,
      occurredAt: clock.now(), failure: null,
    };
    const provider = new FakeProvider([topup]);
    const since = new Date('2025-01-01T00:00:00Z');

    const firstPass = await reconcile({ providers: { stripe: provider }, ledger, repo, policy, clock, ids, since });
    expect(firstPass).toHaveLength(1);
    expect(firstPass[0].kind).toBe('regrant');
    expect(firstPass[0].referenceId).toBe(`topup:${topup.id}`);

    await regrant({ case: firstPass[0], ledger, repo, policy, clock, ids, plan: { pool: 'paid', amount: 50 } });

    const secondPass = await reconcile({ providers: { stripe: provider }, ledger, repo, policy, clock, ids, since });
    expect(secondPass).toHaveLength(0);
  });
});

describe('cs.dispute', () => {
  it('[EC:B11] dispute.opened freezes the customer (default policy.dispute.onOpen) and escalates', async () => {
    await putCustomer();
    const event: NormalizedEvent = {
      id: 'evt_dispute_1', provider: 'stripe', type: 'dispute.opened', occurredAt: clock.now(),
      customerRef: customerId, subscriptionRef: null, paymentRef: null, amount: null, raw: {},
    };
    const csCase = await dispute({ event, policy, ledger, repo, notifier, clock, ids });
    expect(csCase.status).toBe('needs_human');
    const customer = await repo.customers.get(customerId);
    expect(customer!.status).toBe('frozen');
    expect(notifier.sent.some((n) => n.type === 'cs.needs_human')).toBe(true);
  });

  it('[EC:B11] revoke_disputed_grant revokes the full grant tied to the disputed payment', async () => {
    await putCustomer();
    const pol = resolvePolicy({ dispute: { onOpen: 'revoke_disputed_grant' } });
    const payment: Payment = {
      id: 'pay_disputed', customerId, provider: 'stripe', providerRef: 'pi_disputed', subscriptionId: null,
      amount: { amountMinor: 1000, currency: 'USD' }, status: 'succeeded', kind: 'topup', period: null,
      occurredAt: clock.now(), failure: null,
    };
    await repo.payments.put(payment);
    await ledger.append({
      customerId, pool: 'paid', kind: 'grant', amount: 80, unitPriceMinor: 10, currency: 'USD', expiresAt: null,
      source: 'topup', reference: { paymentId: payment.id }, idempotencyKey: `topup:${payment.id}`, actor: 'system', reason: null,
    });
    const event: NormalizedEvent = {
      id: 'evt_dispute_2', provider: 'stripe', type: 'dispute.opened', occurredAt: clock.now(),
      customerRef: customerId, subscriptionRef: null, paymentRef: payment.providerRef, amount: null, raw: {},
    };
    const csCase = await dispute({ event, policy: pol, ledger, repo, notifier, clock, ids });
    expect((await ledger.balance(customerId, 'paid', clock.now())).available).toBe(0);
    const revokeEntries = await ledger.entries(customerId, { kind: 'revoke' });
    // EC:B11 — attributed per grant bucket (reference.grantId), like refund.execute, so expiry (B14)
    // and a later D9 restore can see which bucket each unit came from.
    expect(revokeEntries).toHaveLength(1);
    expect(revokeEntries[0].reference.grantId).toBeDefined();
    expect(revokeEntries[0].idempotencyKey).toBe(`revoke:dispute:${csCase.id}:${revokeEntries[0].reference.grantId}`);
    expect(revokeEntries.reduce((sum, e) => sum + -e.amount, 0)).toBe(80);
  });

  it('[EC:D9] dispute.closed lost -> bans the customer (default policy.dispute.onLost) and resolves resolved_human', async () => {
    await putCustomer();
    const openEvent: NormalizedEvent = {
      id: 'evt_dispute_3', provider: 'stripe', type: 'dispute.opened', occurredAt: clock.now(),
      customerRef: customerId, subscriptionRef: null, paymentRef: 'pi_d9', amount: null, raw: {},
    };
    await dispute({ event: openEvent, policy, ledger, repo, notifier, clock, ids });

    const closeEvent: NormalizedEvent = {
      id: 'evt_dispute_3_closed', provider: 'stripe', type: 'dispute.closed', occurredAt: clock.now(),
      customerRef: customerId, subscriptionRef: null, paymentRef: 'pi_d9', amount: null, raw: { outcome: 'lost' },
    };
    const closed = await dispute({ event: closeEvent, policy, ledger, repo, notifier, clock, ids });
    expect(closed.status).toBe('resolved_human');
    expect(closed.decision).toMatchObject({ outcome: 'lost' });
    const customer = await repo.customers.get(customerId);
    expect(customer!.status).toBe('banned');
  });

  it('[EC:D9] dispute.closed won -> unfreezes a frozen customer, resolves resolved_human', async () => {
    await putCustomer();
    const openEvent: NormalizedEvent = {
      id: 'evt_dispute_4', provider: 'stripe', type: 'dispute.opened', occurredAt: clock.now(),
      customerRef: customerId, subscriptionRef: null, paymentRef: 'pi_d9b', amount: null, raw: {},
    };
    await dispute({ event: openEvent, policy, ledger, repo, notifier, clock, ids });
    expect((await repo.customers.get(customerId))!.status).toBe('frozen');

    const closeEvent: NormalizedEvent = {
      id: 'evt_dispute_4_closed', provider: 'stripe', type: 'dispute.closed', occurredAt: clock.now(),
      customerRef: customerId, subscriptionRef: null, paymentRef: 'pi_d9b', amount: null, raw: { outcome: 'won' },
    };
    const closed = await dispute({ event: closeEvent, policy, ledger, repo, notifier, clock, ids });
    expect(closed.status).toBe('resolved_human');
    expect(closed.decision).toMatchObject({ outcome: 'won' });
    expect((await repo.customers.get(customerId))!.status).toBe('active');
  });

  it('[EC:D9] won AFTER revoke_disputed_grant restores every revoked credit (audit gap #1 regression)', async () => {
    await putCustomer();
    const pol = resolvePolicy({ dispute: { onOpen: 'revoke_disputed_grant' } });
    const payment: Payment = {
      id: 'pay_won', customerId, provider: 'stripe', providerRef: 'pi_won', subscriptionId: null,
      amount: { amountMinor: 1000, currency: 'USD' }, status: 'disputed', kind: 'topup', period: null,
      occurredAt: clock.now(), failure: null,
    };
    await repo.payments.put(payment);
    const expiresAt = new Date(clock.now().getTime() + 30 * 86_400_000);
    await ledger.append({
      customerId, pool: 'paid', kind: 'grant', amount: 100, unitPriceMinor: 10, currency: 'USD', expiresAt,
      source: 'topup', reference: { paymentId: payment.id }, idempotencyKey: `topup:${payment.id}`, actor: 'system', reason: null,
    });
    await dispute({
      event: { id: 'evt_won', provider: 'stripe', type: 'dispute.opened', occurredAt: clock.now(), customerRef: customerId, subscriptionRef: null, paymentRef: payment.providerRef, amount: null, raw: {} },
      policy: pol, ledger, repo, notifier, clock, ids,
    });
    expect((await ledger.balance(customerId, 'paid', clock.now())).available).toBe(0); // revoked while disputed

    const closed = await dispute({
      event: { id: 'evt_won_closed', provider: 'stripe', type: 'dispute.closed', occurredAt: clock.now(), customerRef: customerId, subscriptionRef: null, paymentRef: payment.providerRef, amount: null, raw: { outcome: 'won' } },
      policy: pol, ledger, repo, notifier, clock, ids,
    });
    expect(closed.decision).toMatchObject({ outcome: 'won', restored: 100 });
    expect((await ledger.balance(customerId, 'paid', clock.now())).available).toBe(100); // was 0 before the fix
    const restored = (await ledger.entries(customerId, { kind: 'grant' })).find((e) => e.source === 'dispute');
    expect(restored!.expiresAt?.getTime()).toBe(expiresAt.getTime()); // original expiry preserved

    // replaying the same close must not grant twice
    const again = await dispute({
      event: { id: 'evt_won_closed', provider: 'stripe', type: 'dispute.closed', occurredAt: clock.now(), customerRef: customerId, subscriptionRef: null, paymentRef: payment.providerRef, amount: null, raw: { outcome: 'won' } },
      policy: pol, ledger, repo, notifier, clock, ids,
    });
    expect(again.decision).toMatchObject({ restored: 0 });
    expect((await ledger.balance(customerId, 'paid', clock.now())).available).toBe(100);
  });

  it('[EC:D9] lost with onOpen=freeze_customer still revokes the credits (revoke_only honours its name)', async () => {
    await putCustomer();
    const pol = resolvePolicy({ dispute: { onOpen: 'freeze_customer', onLost: 'revoke_only' } });
    const payment: Payment = {
      id: 'pay_lost', customerId, provider: 'stripe', providerRef: 'pi_lost', subscriptionId: null,
      amount: { amountMinor: 1000, currency: 'USD' }, status: 'disputed', kind: 'topup', period: null,
      occurredAt: clock.now(), failure: null,
    };
    await repo.payments.put(payment);
    await ledger.append({
      customerId, pool: 'paid', kind: 'grant', amount: 60, unitPriceMinor: 10, currency: 'USD', expiresAt: null,
      source: 'topup', reference: { paymentId: payment.id }, idempotencyKey: `topup:${payment.id}`, actor: 'system', reason: null,
    });
    await dispute({
      event: { id: 'evt_lost', provider: 'stripe', type: 'dispute.opened', occurredAt: clock.now(), customerRef: customerId, subscriptionRef: null, paymentRef: payment.providerRef, amount: null, raw: {} },
      policy: pol, ledger, repo, notifier, clock, ids,
    });
    expect((await ledger.balance(customerId, 'paid', clock.now())).available).toBe(60); // only frozen so far

    const closed = await dispute({
      event: { id: 'evt_lost_closed', provider: 'stripe', type: 'dispute.closed', occurredAt: clock.now(), customerRef: customerId, subscriptionRef: null, paymentRef: payment.providerRef, amount: null, raw: { outcome: 'lost' } },
      policy: pol, ledger, repo, notifier, clock, ids,
    });
    expect(closed.decision).toMatchObject({ outcome: 'lost', revoked: 60 });
    expect((await ledger.balance(customerId, 'paid', clock.now())).available).toBe(0); // was 60 before the fix
    expect((await repo.customers.get(customerId))!.status).toBe('frozen'); // revoke_only does not ban
  });

  it('[EC:L5] revoke_disputed_grant stamps correlationId on the revoke entry', async () => {
    await putCustomer();
    const pol = resolvePolicy({ dispute: { onOpen: 'revoke_disputed_grant' } });
    const payment: Payment = {
      id: 'pay_l5_dispute', customerId, provider: 'stripe', providerRef: 'pi_l5_dispute', subscriptionId: null,
      amount: { amountMinor: 1000, currency: 'USD' }, status: 'succeeded', kind: 'topup', period: null,
      occurredAt: clock.now(), failure: null,
    };
    await repo.payments.put(payment);
    await ledger.append({
      customerId, pool: 'paid', kind: 'grant', amount: 80, unitPriceMinor: 10, currency: 'USD', expiresAt: null,
      source: 'topup', reference: { paymentId: payment.id }, idempotencyKey: `topup:${payment.id}`, actor: 'system', reason: null,
    });
    const event: NormalizedEvent = {
      id: 'evt_dispute_l5', provider: 'stripe', type: 'dispute.opened', occurredAt: clock.now(),
      customerRef: customerId, subscriptionRef: null, paymentRef: payment.providerRef, amount: null, raw: {},
    };
    const csCase = await dispute({ event, policy: pol, ledger, repo, notifier, clock, ids, correlationId: 'corr_dispute_1' });
    const revokeEntries = await ledger.entries(customerId, { kind: 'revoke' });
    expect(revokeEntries).toHaveLength(1);
    expect(revokeEntries[0].reference.correlationId).toBe('corr_dispute_1');

    // D9 won -> restore must carry the SAME correlationId too.
    const closed = await dispute({
      event: { id: 'evt_dispute_l5_closed', provider: 'stripe', type: 'dispute.closed', occurredAt: clock.now(), customerRef: customerId, subscriptionRef: null, paymentRef: payment.providerRef, amount: null, raw: { outcome: 'won' } },
      policy: pol, ledger, repo, notifier, clock, ids, correlationId: 'corr_dispute_1',
    });
    expect(closed.decision).toMatchObject({ outcome: 'won', restored: 80 });
    const grantEntries = await ledger.entries(customerId, { kind: 'grant', source: 'dispute' });
    expect(grantEntries[0]?.reference.correlationId).toBe('corr_dispute_1');
    void csCase;
  });
});

describe('cs.churn.record — EC:I4', () => {
  it('records onto an open case (always collected)', async () => {
    const csCase = await openCase({ customerId, kind: 'refund', referenceId: 'churn_ref', policy, repo, clock, ids });
    const record = await churn.record({ customerId, reason: 'too_expensive', text: 'switched to a cheaper plan', case: csCase, repo, clock });
    expect(record.reason).toBe('too_expensive');
    const reread = await repo.csCases.get(csCase.id);
    expect(reread!.churnReason).toBe('too_expensive');
    expect(reread!.churnText).toBe('switched to a cheaper plan');
  });

  it('a bare customerId-only call (no case) returns the record without persisting (documented contract gap)', async () => {
    const record = await churn.record({ customerId, reason: 'not_using', clock });
    expect(record).toMatchObject({ customerId, reason: 'not_using', text: null });
    expect(record.recordedAt).not.toBeNull();
  });
});

describe('cs.widget — EC:I6', () => {
  const secret = 'test-secret';

  it('valid sign/verify round trip', () => {
    const token = widget.signToken({ customerId, ttlSeconds: 60 }, secret);
    const claims = widget.verifyToken(token, secret);
    expect(claims.customerId).toBe(customerId);
  });

  it('expired token is rejected', () => {
    const token = widget.signToken({ customerId, ttlSeconds: -1 }, secret);
    expect(() => widget.verifyToken(token, secret)).toThrowError(/expired/);
  });

  it('tampered signature is rejected', () => {
    const token = widget.signToken({ customerId, ttlSeconds: 60 }, secret);
    const [header, payload] = token.split('.');
    const tampered = `${header}.${payload}.deadbeef`;
    expect(() => widget.verifyToken(tampered, secret)).toThrowError(/signature/);
  });

  it('wrong secret is rejected', () => {
    const token = widget.signToken({ customerId, ttlSeconds: 60 }, secret);
    expect(() => widget.verifyToken(token, 'other-secret')).toThrowError(/signature/);
  });
});

describe('cs.Metrics / cs.CaseMeter — EC:I5', () => {
  it('Metrics.snapshot tallies opened/escalated/resolved/churn events from onCaseEvent', async () => {
    const metrics = new Metrics();
    const c1 = await openCase({ customerId, kind: 'refund', referenceId: 'm1', policy, repo, clock, ids, onCaseEvent: metrics.record });
    await resolve({ case: c1, by: 'auto', decision: {}, repo, clock, onCaseEvent: metrics.record });
    const c2 = await openCase({ customerId, kind: 'dispute', referenceId: 'm2', policy, repo, clock, ids, onCaseEvent: metrics.record });
    await escalate({ case: c2, repo, clock, reason: 'needs review', onCaseEvent: metrics.record });

    const snap = metrics.snapshot();
    expect(snap.countsByKind.refund).toBe(1);
    expect(snap.countsByKind.dispute).toBe(1);
    expect(snap.countsByStatus.resolved_auto).toBe(1);
    expect(snap.countsByStatus.needs_human).toBe(1);
    expect(snap.durationsMsByKind.refund).toEqual([0]); // FixedClock did not advance between open/resolve
  });

  it('CaseMeter.countBillable counts only resolved_auto/resolved_human/rejected', async () => {
    const open = await openCase({ customerId, kind: 'refund', referenceId: 'cm1', policy, repo, clock, ids });
    const needsHuman = await openCase({ customerId, kind: 'refund', referenceId: 'cm2', policy, repo, clock, ids });
    await escalate({ case: needsHuman, repo, clock, reason: 'x' });
    const auto = await openCase({ customerId, kind: 'refund', referenceId: 'cm3', policy, repo, clock, ids });
    await resolve({ case: auto, by: 'auto', decision: {}, repo, clock });
    const human = await openCase({ customerId, kind: 'refund', referenceId: 'cm4', policy, repo, clock, ids });
    await resolve({ case: human, by: 'human', decision: {}, repo, clock });
    const rejected = await openCase({ customerId, kind: 'refund', referenceId: 'cm5', policy, repo, clock, ids });
    await reject({ case: rejected, reason: 'no', repo, clock });
    void open;

    const meter = new CaseMeter(repo);
    expect(await meter.countBillable({ customerId })).toBe(3); // auto + human + rejected, not open/needs_human
  });
});

describe('cs.HttpLicenseReporter — EC:I5', () => {
  function fakeFetch(responses: (input: RequestInfo | URL, init?: RequestInit) => { ok: boolean; status: number; json?: () => Promise<unknown> }) {
    const calls: { url: string; init?: RequestInit }[] = [];
    const fn = (async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: String(input), init });
      const r = responses(input, init);
      return { ok: r.ok, status: r.status, json: r.json ?? (async () => ({})) } as Response;
    }) as typeof fetch;
    return { fn, calls };
  }

  it('reportCase POSTs once with an Authorization: Bearer header on success', async () => {
    const { fn, calls } = fakeFetch(() => ({ ok: true, status: 200 }));
    const reporter = new HttpLicenseReporter({ apiKey: 'sk_test_123', fetch: fn });
    await reporter.reportCase({ caseId: 'case_1', kind: 'refund', status: 'resolved_auto', tenantRef: customerId, occurredAt: clock.now() });
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toMatch(/\/cases$/);
    expect(calls[0].init?.method).toBe('POST');
    expect((calls[0].init?.headers as Record<string, string>).Authorization).toBe('Bearer sk_test_123');
  });

  it('a 500 response is queued (does not throw); flush() sends it once the endpoint recovers', async () => {
    let fail = true;
    const { fn, calls } = fakeFetch(() => (fail ? { ok: false, status: 500 } : { ok: true, status: 200 }));
    const reporter = new HttpLicenseReporter({ apiKey: 'sk_test_123', fetch: fn });
    await expect(reporter.reportCase({ caseId: 'case_2', kind: 'refund', status: 'resolved_auto', tenantRef: customerId, occurredAt: clock.now() }))
      .resolves.toBeUndefined();
    expect(calls).toHaveLength(1); // the failed attempt

    fail = false;
    const result = await reporter.flush();
    expect(result).toEqual({ sent: 1, remaining: 0 });
    expect(calls).toHaveLength(2); // the retried attempt
  });

  it('resolve() through a real HttpLicenseReporter makes exactly one POST per billable transition', async () => {
    const { fn, calls } = fakeFetch(() => ({ ok: true, status: 200 }));
    const reporter = new HttpLicenseReporter({ apiKey: 'sk_test_123', fetch: fn });
    const csCase = await openCase({ customerId, kind: 'refund', referenceId: 'http_1', policy, repo, clock, ids });
    await resolve({ case: csCase, by: 'auto', decision: {}, repo, clock, reporter });
    expect(calls).toHaveLength(1);
  });
});
