import { expect, it } from 'vitest';
import { FixedClock, InMemoryLedger, InMemoryRepo, SequentialIdGen, hashPayload, resolvePolicy } from 'boilpayment-core';
import { reconcile } from '../src/index.js';

it('OT-09 escalates an expired unregistered payment hold exactly once', async () => {
  // Given
  const clock = new FixedClock(new Date('2026-09-29T01:00:00.000Z'));
  const ids = new SequentialIdGen('hold_');
  const repo = new InMemoryRepo();
  const payload = { paymentId: 'payment:stripe:pi_1', checkoutId: 'cs_1', customerId: 'customer', receivedAt: '2026-09-28T00:00:00.000Z' };
  await repo.operations.put({ id: 'checkout-payment-held:payment:stripe:pi_1', key: 'checkout-payment-held:payment:stripe:pi_1',
    kind: 'checkout.paymentHeld', payloadHash: hashPayload(payload), status: 'done', result: payload, error: null,
    createdAt: new Date(payload.receivedAt), completedAt: new Date(payload.receivedAt), attempts: 1 });
  const input = { providers: {}, ledger: new InMemoryLedger(ids), repo, policy: resolvePolicy(), clock, ids,
    since: new Date('2026-09-28T00:00:00.000Z') };

  // When
  await reconcile(input);
  await reconcile(input);

  // Then
  expect(await repo.csCases.list({ kind: 'reconcile_mismatch', referenceId: payload.paymentId })).toHaveLength(1);
});

it('OT-09 leaves a held payment alone inside the window and opens one case after it, no regrant', async () => {
  // Given
  const received = new Date('2026-09-28T00:00:00.000Z');
  const ids = new SequentialIdGen('hold_');
  const repo = new InMemoryRepo();
  const payload = { paymentId: 'payment:stripe:pi_1', checkoutId: 'cs_1', customerId: 'customer', receivedAt: received.toISOString() };
  await repo.operations.put({ id: 'checkout-payment-held:payment:stripe:pi_1', key: 'checkout-payment-held:payment:stripe:pi_1',
    kind: 'checkout.paymentHeld', payloadHash: hashPayload(payload), status: 'done', result: payload, error: null,
    createdAt: received, completedAt: received, attempts: 1 });
  await repo.customers.put({ id: 'customer', email: null, providerRefs: [{ provider: 'stripe', ref: 'cus_1' }], status: 'active', createdAt: received });
  const heldPayment = { id: 'pi_1', customerId: '', provider: 'stripe', providerRef: 'pi_1', subscriptionId: null,
    amount: { amountMinor: 1000, currency: 'USD' }, status: 'succeeded', kind: 'topup', period: null, occurredAt: received, failure: null } as never;
  const providers = { stripe: { listPayments: async () => [heldPayment] } } as never;
  const at = (iso: string) => ({ providers, ledger: new InMemoryLedger(ids), repo, policy: resolvePolicy(), clock: new FixedClock(new Date(iso)), ids, since: received });

  // When / Then
  await reconcile(at('2026-09-28T23:00:00.000Z'));
  expect(await repo.csCases.list()).toHaveLength(0);
  await reconcile(at('2026-09-29T01:00:00.000Z'));
  await reconcile(at('2026-09-29T01:00:00.000Z'));
  const cases = await repo.csCases.list();
  expect(cases).toHaveLength(1);
  expect(cases[0]).toMatchObject({ kind: 'reconcile_mismatch', status: 'needs_human' });
});
