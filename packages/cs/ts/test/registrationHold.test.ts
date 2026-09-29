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
