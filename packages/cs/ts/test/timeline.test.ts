// spec: packages/cs/spec/cs.pseudo.md [EC:I9]
// Mirrors packages/cs/py/tests/test_timeline.py (same fixtures, same expected strings).
//
// NOTE on clocks: InMemoryLedger.append() stamps `createdAt` with the REAL wall clock (ignores the
// injected Clock — see final report finding). To interleave ledger-sourced events correctly with
// clock-sourced ones (payments/refunds/cs_cases) in an exact-ordering test, `clock` here is a
// FixedClock seeded with `new Date()` (real "now") and advanced in lockstep with a real `sleep()`
// between narrative steps, instead of a hardcoded past date that would always sort before real time.
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_POLICY, FixedClock, InMemoryLedger, InMemoryRepo, NormalizedEvent, Payment, Refund,
  SequentialIdGen, runIdempotent,
} from '@schift/payment-kit-core';
import { dispute, explain, timeline } from '../src/index.js';

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function tick(clock: FixedClock, ms = 5): Promise<void> {
  // InMemoryLedger now takes the clock, so no real sleep is needed to keep the two in step.
  clock.advance(ms);
}

describe('cs.timeline', () => {
  it('[EC:I9] happy path: payment -> grant -> consume -> refund -> revoke, exact order + running balance + explain', async () => {
    const repo = new InMemoryRepo();
    const clock = new FixedClock(new Date());
    const ledger = new InMemoryLedger(new SequentialIdGen('led_'), clock);
    const customerId = 'cust_happy';

    const payment: Payment = {
      id: 'pay_1', customerId, provider: 'toss', providerRef: 'toss_1', subscriptionId: null,
      amount: { amountMinor: 9900, currency: 'KRW' }, status: 'succeeded', kind: 'topup', period: null,
      occurredAt: clock.now(), failure: null, cashReceipt: null,
    };
    await repo.payments.put(payment);
    await tick(clock);

    const granted = await ledger.append({
      customerId, pool: 'paid', kind: 'grant', amount: 100, unitPriceMinor: null, currency: null,
      expiresAt: null, source: 'topup', reference: { paymentId: payment.id }, idempotencyKey: `topup:${payment.id}`,
      actor: 'system', reason: null,
    });
    await tick(clock);

    await ledger.append({
      customerId, pool: 'paid', kind: 'consume', amount: -40, unitPriceMinor: null, currency: null,
      expiresAt: null, source: 'usage', reference: { grantId: granted.entry.id }, idempotencyKey: 'consume:1',
      actor: 'app', reason: null,
    });
    await tick(clock);

    const refund: Refund = {
      id: 'ref_1', paymentId: payment.id, customerId, amount: { amountMinor: 6000, currency: 'KRW' },
      status: 'succeeded', providerRef: 'toss_refund_1', creditsRevoked: 60, ruleId: 'D1', reason: null,
      failure: null, createdAt: clock.now(),
    };
    await repo.refunds.put(refund);
    await tick(clock);

    await ledger.append({
      customerId, pool: 'paid', kind: 'revoke', amount: -60, unitPriceMinor: null, currency: null,
      expiresAt: null, source: 'refund', reference: { paymentId: payment.id, refundId: refund.id, grantId: granted.entry.id },
      idempotencyKey: `revoke:refund:${refund.id}`, actor: 'system', reason: null,
    });

    const result = await timeline({ customerId, repo, ledger, clock });
    expect(result.truncated).toBe(false);
    expect(result.events.map((e) => e.kind)).toEqual([
      'payment.succeeded', 'credits.granted', 'credits.consumed', 'refund.succeeded', 'credits.revoked',
    ]);

    const ledgerEvents = result.events.filter((e) => e.source === 'ledger_entries');
    expect(ledgerEvents.map((e) => e.detail.balanceAfter)).toEqual([100, 60, 0]);

    expect(explain(result.events)).toEqual([
      'payment pay_1 succeeded (₩9,900)',
      '100 credits granted',
      '40 credits consumed',
      'refund ref_1 for ₩6,000 (D1), 60 credits revoked',
      '60 credits revoked',
      'balance now 0',
    ]);
  });

  it('[EC:I9] webhook-failure story (unknown_provider_ref) — global query only (webhook_events has no customer/payment link)', async () => {
    const repo = new InMemoryRepo();
    const clock = new FixedClock(new Date());
    const ledger = new InMemoryLedger(new SequentialIdGen('led_'), clock);

    await repo.webhookEvents.put({
      id: 'evt_orphan_1', provider: 'toss', type: 'payment.succeeded', status: 'failed',
      rawBody: '{}', headers: {}, receivedAt: clock.now(), processedAt: clock.now(),
      error: 'unknown_provider_ref', attempts: 1,
    });

    const scoped = await timeline({ customerId: 'someone_else', repo, ledger, clock });
    expect(scoped.events.filter((e) => e.source === 'webhook_events')).toHaveLength(0);

    const global = await timeline({ repo, ledger, clock });
    expect(global.events).toHaveLength(1);
    expect(global.events[0]).toMatchObject({
      kind: 'webhook.failed', source: 'webhook_events',
      summary: 'webhook toss payment.succeeded failed: unknown_provider_ref',
    });
  });

  it('[EC:I9] dispute story: opened -> escalated -> credits revoked -> won -> resolved -> credits restored (reuses cs.dispute)', async () => {
    const repo = new InMemoryRepo();
    const clock = new FixedClock(new Date());
    const ledger = new InMemoryLedger(new SequentialIdGen('led_'), clock);
    const ids = new SequentialIdGen('id_');
    const customerId = 'cust_dispute';
    const policy = { ...DEFAULT_POLICY, dispute: { onOpen: 'revoke_disputed_grant' as const, onLost: 'revoke_and_ban' as const } };

    await repo.customers.put({ id: customerId, email: null, providerRefs: [], status: 'active', createdAt: clock.now() });
    const payment: Payment = {
      id: 'pay_d1', customerId, provider: 'stripe', providerRef: 'pi_d1', subscriptionId: null,
      amount: { amountMinor: 1000, currency: 'USD' }, status: 'succeeded', kind: 'topup', period: null,
      occurredAt: clock.now(), failure: null, cashReceipt: null,
    };
    await repo.payments.put(payment);
    await ledger.append({
      customerId, pool: 'paid', kind: 'grant', amount: 80, unitPriceMinor: null, currency: null,
      expiresAt: null, source: 'topup', reference: { paymentId: payment.id }, idempotencyKey: `topup:${payment.id}`,
      actor: 'system', reason: null,
    });
    await tick(clock);

    const openEvent: NormalizedEvent = {
      id: 'evt_open', provider: 'stripe', type: 'dispute.opened', occurredAt: clock.now(),
      customerRef: customerId, subscriptionRef: null, paymentRef: payment.providerRef, amount: null, raw: {},
    };
    const opened = await dispute({ event: openEvent, policy, ledger, repo, notifier: { send: async () => {} }, clock, ids });
    await tick(clock, 50);

    const closeEvent: NormalizedEvent = {
      id: 'evt_close', provider: 'stripe', type: 'dispute.closed', occurredAt: clock.now(),
      customerRef: customerId, subscriptionRef: null, paymentRef: payment.providerRef, amount: null, raw: { outcome: 'won' },
    };
    await dispute({ event: closeEvent, policy, ledger, repo, notifier: { send: async () => {} }, clock, ids });

    const result = await timeline({ customerId, repo, ledger, clock });
    const kinds = result.events.map((e) => e.kind);
    expect(kinds).toEqual([
      // dispute() restores the credits and THEN resolves the case, so the restore comes first at
      // that instant (EC:I9 tie-break: credits.* ranks before case.resolved).
      'payment.succeeded', 'credits.granted', 'case.opened', 'case.escalated', 'credits.revoked',
      'credits.granted', 'case.resolved',
    ]);
    expect(result.events.every((e) => e.refs.caseId === undefined || e.refs.caseId === opened.id)).toBe(true);
    const revokeEvent = result.events.find((e) => e.kind === 'credits.revoked')!;
    expect(revokeEvent.detail.amount).toBe(-80);
    // the restore is the LAST credits.granted, not the last event (case.resolved closes the story)
    const grants = result.events.filter((e) => e.kind === 'credits.granted');
    expect(grants[grants.length - 1].detail.amount).toBe(80);
    expect(result.events[result.events.length - 1].kind).toBe('case.resolved');
    expect((await ledger.balance(customerId, 'paid', clock.now())).available).toBe(80);
  });

  it('[EC:I9] replayed-operation story: a second call through runIdempotent replays without re-executing; timeline shows one operation.replayed', async () => {
    const repo = new InMemoryRepo();
    const clock = new FixedClock(new Date());
    const ledger = new InMemoryLedger(new SequentialIdGen('led_'), clock);
    const customerId = 'cust_replay';
    const paymentId = 'pay_replay_1';
    let executions = 0;

    const call = () => runIdempotent<{ granted: number }>({
      repo, clock, key: `topup:${paymentId}`, kind: 'credits.topup', payload: { paymentId },
      fn: async () => { executions += 1; return { granted: 100 }; },
    });

    const first = await call();
    expect(first.replayed).toBe(false);
    const second = await call();
    expect(second.replayed).toBe(true);
    expect(executions).toBe(1); // proves the "customer clicked twice" didn't double-execute

    const result = await timeline({ paymentId, repo, ledger, clock });
    const opEvents = result.events.filter((e) => e.kind === 'operation.replayed');
    expect(opEvents).toHaveLength(1);
    expect(opEvents[0].detail).toMatchObject({ key: `topup:${paymentId}`, kind: 'credits.topup' });
    void customerId;
  });

  it('[EC:I9] paymentId-scoped query pulls only the ledger/refund/case rows for that payment', async () => {
    const repo = new InMemoryRepo();
    const clock = new FixedClock(new Date());
    const ledger = new InMemoryLedger(new SequentialIdGen('led_'), clock);

    const paymentA: Payment = {
      id: 'pay_A', customerId: 'cust_A', provider: 'stripe', providerRef: 'pi_A', subscriptionId: null,
      amount: { amountMinor: 500, currency: 'USD' }, status: 'succeeded', kind: 'topup', period: null,
      occurredAt: clock.now(), failure: null, cashReceipt: null,
    };
    const paymentB: Payment = {
      id: 'pay_B', customerId: 'cust_A', provider: 'stripe', providerRef: 'pi_B', subscriptionId: null,
      amount: { amountMinor: 700, currency: 'USD' }, status: 'succeeded', kind: 'topup', period: null,
      occurredAt: clock.now(), failure: null, cashReceipt: null,
    };
    await repo.payments.put(paymentA);
    await repo.payments.put(paymentB);
    await ledger.append({
      customerId: 'cust_A', pool: 'paid', kind: 'grant', amount: 50, unitPriceMinor: null, currency: null,
      expiresAt: null, source: 'topup', reference: { paymentId: 'pay_A' }, idempotencyKey: 'topup:pay_A',
      actor: 'system', reason: null,
    });
    await ledger.append({
      customerId: 'cust_A', pool: 'paid', kind: 'grant', amount: 70, unitPriceMinor: null, currency: null,
      expiresAt: null, source: 'topup', reference: { paymentId: 'pay_B' }, idempotencyKey: 'topup:pay_B',
      actor: 'system', reason: null,
    });
    await repo.refunds.put({
      id: 'ref_A', paymentId: 'pay_A', customerId: 'cust_A', amount: { amountMinor: 500, currency: 'USD' },
      status: 'succeeded', providerRef: null, creditsRevoked: 50, ruleId: 'D1', reason: null, failure: null,
      createdAt: clock.now(),
    });
    await repo.csCases.put({
      id: 'case_A', customerId: 'cust_A', kind: 'refund', status: 'resolved_auto', referenceId: 'pay_A',
      policySnapshot: DEFAULT_POLICY, decision: {}, churnReason: null, churnText: null,
      openedAt: clock.now(), resolvedAt: clock.now(),
    });

    const result = await timeline({ paymentId: 'pay_A', repo, ledger, clock });
    expect(result.events.every((e) => e.refs.paymentId === undefined || e.refs.paymentId === 'pay_A')).toBe(true);
    const grantAmounts = result.events.filter((e) => e.kind === 'credits.granted').map((e) => e.detail.amount);
    expect(grantAmounts).toEqual([50]);
    expect(result.events.some((e) => e.kind === 'refund.succeeded' && e.refs.refundId === 'ref_A')).toBe(true);
    expect(result.events.some((e) => e.kind === 'case.resolved' && e.refs.caseId === 'case_A')).toBe(true);
    expect(result.events.some((e) => e.detail.amount === 70)).toBe(false);
  });

  it('[EC:I9] truncation: keeps the newest `limit` events and sets truncated', async () => {
    const repo = new InMemoryRepo();
    const clock = new FixedClock(new Date());
    const ledger = new InMemoryLedger(new SequentialIdGen('led_'), clock);
    const customerId = 'cust_trunc';

    for (let i = 0; i < 5; i++) {
      await ledger.append({
        customerId, pool: 'paid', kind: 'grant', amount: 10, unitPriceMinor: null, currency: null,
        expiresAt: null, source: 'manual', reference: {}, idempotencyKey: `grant:${i}`, actor: 'system', reason: null,
      });
      await tick(clock, 2);
    }

    const full = await timeline({ customerId, repo, ledger, clock });
    expect(full.truncated).toBe(false);
    expect(full.events).toHaveLength(5);

    const limited = await timeline({ customerId, repo, ledger, clock, limit: 2 });
    expect(limited.truncated).toBe(true);
    expect(limited.events).toHaveLength(2);
    expect(limited.events.map((e) => e.at.getTime())).toEqual(full.events.slice(3).map((e) => e.at.getTime()));
  });

  it('[EC:L5] timeline({correlationId}) returns exactly the events of one webhook delivery, nothing else', async () => {
    const repo = new InMemoryRepo();
    const clock = new FixedClock(new Date());
    const ledger = new InMemoryLedger(new SequentialIdGen('led_'), clock);
    const customerId = 'cust_l5';

    // Two "deliveries" interleaved on the same customer: corr_a's grant+consume, corr_b's grant, and
    // one entry with NO correlationId at all (a direct, non-webhook call) — none of it should leak in.
    await ledger.append({
      customerId, pool: 'paid', kind: 'grant', amount: 100, unitPriceMinor: null, currency: null,
      expiresAt: null, source: 'topup', reference: { paymentId: 'pay_a', correlationId: 'corr_a' },
      idempotencyKey: 'topup:pay_a', actor: 'system', reason: null,
    });
    await tick(clock);
    await ledger.append({
      customerId, pool: 'paid', kind: 'grant', amount: 50, unitPriceMinor: null, currency: null,
      expiresAt: null, source: 'topup', reference: { paymentId: 'pay_b', correlationId: 'corr_b' },
      idempotencyKey: 'topup:pay_b', actor: 'system', reason: null,
    });
    await tick(clock);
    await ledger.append({
      customerId, pool: 'paid', kind: 'consume', amount: -20, unitPriceMinor: null, currency: null,
      expiresAt: null, source: 'usage', reference: { correlationId: 'corr_a' },
      idempotencyKey: 'consume:corr_a', actor: 'app', reason: null,
    });
    await tick(clock);
    await ledger.append({
      customerId, pool: 'paid', kind: 'grant', amount: 5, unitPriceMinor: null, currency: null,
      expiresAt: null, source: 'manual', reference: {}, idempotencyKey: 'grant:no_corr', actor: 'system', reason: null,
    });

    const scoped = await timeline({ customerId, correlationId: 'corr_a', repo, ledger, clock });
    expect(scoped.events).toHaveLength(2);
    expect(scoped.events.every((e) => e.refs.correlationId === 'corr_a')).toBe(true);
    expect(scoped.events.map((e) => e.kind)).toEqual(['credits.granted', 'credits.consumed']);

    const full = await timeline({ customerId, repo, ledger, clock });
    expect(full.events).toHaveLength(4); // nothing dropped when correlationId is not passed
  });
});
