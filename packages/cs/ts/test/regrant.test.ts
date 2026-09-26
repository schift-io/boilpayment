// Regression test for cs.regrant's plan.idempotencyKey override.
// spec: packages/cs/spec/cs.pseudo.md [EC:E2]
// NOTE: EC:A18/E1/E2/E14 mode variants + default-idempotency-key dedupe are already covered by
// cs.test.ts's "cs.regrant" describe block and reconcile.test.ts's E1/E14 pass — this file only
// adds the one plan.idempotencyKey-override path that isn't exercised elsewhere.
import { describe, expect, it } from 'vitest';
import { FixedClock, InMemoryLedger, InMemoryRepo, resolvePolicy, SequentialIdGen } from '@schift/payment-kit-core';
import { openCase, regrant } from '../src/index.js';

const clock = new FixedClock(new Date('2026-03-01T00:00:00.000Z'));

describe('EC:E2 regrant plan.idempotencyKey overrides case.referenceId as the ledger dedupe key', () => {
  it('EC:E2 uses plan.idempotencyKey (not case.referenceId) as the ledger entry idempotency key when given', async () => {
    const repo = new InMemoryRepo();
    const ledger = new InMemoryLedger(new SequentialIdGen('led_'));
    const ids = new SequentialIdGen('id_');
    const policy = resolvePolicy({ cs: { regrant: { mode: 'auto' } } });
    const csCase = await openCase({ customerId: 'cust_f', kind: 'regrant', referenceId: 'grant_f1', policy, repo, clock, ids });

    const resolved = await regrant({
      case: csCase, ledger, repo, policy, clock, ids, plan: { pool: 'paid', amount: 15, idempotencyKey: 'custom_key_1' },
    });
    expect(resolved.decision).toMatchObject({ idempotencyKey: 'custom_key_1' });
    const entries = await ledger.entries('cust_f', { kind: 'grant' });
    expect(entries.some((e) => e.idempotencyKey === 'custom_key_1')).toBe(true);
    expect(entries.some((e) => e.idempotencyKey === 'grant_f1')).toBe(false); // case.referenceId was NOT used
  });
});

it('uses stored off rules despite a caller auto policy', async () => {
  const repo = new InMemoryRepo(); const ids = new SequentialIdGen('rules_');
  const ledger = new InMemoryLedger(ids);
  const policy = resolvePolicy({ cs: { regrant: { mode: 'off' } } });
  const csCase = await openCase({ customerId: 'c', kind: 'regrant', referenceId: 'p', policy, repo, clock, ids });
  const result = await regrant({ case: csCase, ledger, repo, clock, ids, policy: resolvePolicy({ cs: { regrant: { mode: 'auto' } } }), plan: { pool: 'paid', amount: 10 } });
  expect(result.status).toBe('rejected');
  expect(await ledger.entries('c')).toHaveLength(0);
});

it('allows approval of the same escalated case without an idempotency conflict', async () => {
  const repo = new InMemoryRepo(); const ids = new SequentialIdGen('approval_');
  const ledger = new InMemoryLedger(ids);
  const policy = resolvePolicy({ cs: { regrant: { mode: 'manual_approve' } } });
  const csCase = await openCase({ customerId: 'c', kind: 'regrant', referenceId: 'p', policy, repo, clock, ids });
  const input = { case: csCase, ledger, repo, clock, ids, policy, plan: { pool: 'paid' as const, amount: 10 } };
  const pending = await regrant(input);
  expect(pending.status).toBe('needs_human');
  const resolved = await regrant({ ...input, case: pending, approvedBy: 'operator' });
  expect(resolved.status).toBe('resolved_auto');
  const replay = await regrant(input);
  expect(replay.status).toBe('resolved_auto');
  expect(await ledger.entries('c', { kind: 'grant' })).toHaveLength(1);
});

it.each([{ customerId: 'other', amount: 10 }, { customerId: 'c', amount: -1 }])('rejects invalid grant ownership or amount %j', async (plan) => {
  const repo = new InMemoryRepo(); const ids = new SequentialIdGen('invalid_');
  const ledger = new InMemoryLedger(ids); const policy = resolvePolicy({ cs: { regrant: { mode: 'auto' } } });
  const csCase = await openCase({ customerId: 'c', kind: 'regrant', referenceId: 'p', policy, repo, clock, ids });
  const result = await regrant({ case: csCase, ledger, repo, clock, ids, policy, plan: { ...plan, pool: 'paid' } });
  expect(result.status).toBe('rejected');
  expect(await ledger.entries('c')).toHaveLength(0);
  expect(await ledger.entries('other')).toHaveLength(0);
});
