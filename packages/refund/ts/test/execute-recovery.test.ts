// EC:D12 D15 J1 — provider transport uncertainty and local settlement retries.
import { expect, it, vi } from 'vitest';
import { FixedClock, InMemoryLedger, InMemoryRepo, SequentialIdGen, resolvePolicy } from '@schift/payment-kit-core';
import type { PaymentProvider, Refund, Money } from '@schift/payment-kit-core';
import { evaluate, execute } from '../src/index.js';

async function setup() {
  const clock = new FixedClock(new Date('2026-01-01T00:00:00Z'));
  const ids = new SequentialIdGen('id_');
  const ledger = new InMemoryLedger(ids);
  const repo = new InMemoryRepo();
  const policy = resolvePolicy();
  const payment = { id: 'pay_1', customerId: 'cust_1', provider: 'stripe' as const, providerRef: 'pi_1',
    subscriptionId: null, amount: { amountMinor: 1000, currency: 'USD' as const }, status: 'succeeded' as const,
    kind: 'topup' as const, period: null, occurredAt: clock.now(), failure: null };
  await repo.payments.put(payment);
  await ledger.append({ customerId: 'cust_1', pool: 'paid', kind: 'grant', amount: 100,
    unitPriceMinor: 10, currency: 'USD', expiresAt: null, source: 'topup', reference: { paymentId: payment.id },
    idempotencyKey: 'seed', actor: 'system', reason: null });
  const unused = async (): Promise<never> => { throw new Error('unexpected provider call'); };
  const requests: Money[] = [];
  const provider = {
    name: 'stripe', capabilities: () => ({ nativeSubscriptions: true, partialRefund: true,
      meters: false, scheduling: 'provider', webhookSignature: true }),
    createCustomer: unused, createCheckout: unused, getPayment: unused, listPayments: unused,
    getSubscription: unused, changeSubscription: unused, cancelSubscription: unused,
    uncancelSubscription: unused, chargeBillingKey: unused, reportUsage: unused, verifyWebhook: unused,
    refund: vi.fn(async (input: { amount: Money }): Promise<Refund> => { requests.push(input.amount); return ({
      id: 'provider_refund', paymentId: payment.id, customerId: payment.customerId, amount: input.amount,
      status: 'succeeded', providerRef: 'provider_refund', creditsRevoked: 0, ruleId: '', reason: null,
      failure: null, createdAt: clock.now(),
    }); }),
  } satisfies PaymentProvider;
  return { clock, ids, ledger, repo, policy, provider, requests,
    decision: await evaluate({ payment, policy, ledger, repo, clock }) };
}

it('keeps timeout outcome pending and never submits a second provider refund', async () => {
  const input = await setup();
  input.provider.refund.mockRejectedValue(new Error('request timed out after submission'));
  const first = await execute(input);
  expect(first.status).toBe('pending');
  expect(first.failure).toMatchObject({ code: 'refund_outcome_unknown', retryable: false });
  expect((await input.ledger.balance('cust_1', 'paid', input.clock.now())).available).toBe(0);
  expect((await input.ledger.entries('cust_1')).filter((entry) => entry.kind === 'release')).toEqual([]);
  expect(await execute(input)).toEqual(first);
  expect(input.provider.refund).toHaveBeenCalledTimes(1);
});

it.each(['revoke', 'payment', 'refund'] as const)('resumes local %s failure after provider success without refunding twice', async (failure) => {
  const input = await setup();
  const error = new Error('local storage unavailable');
  if (failure === 'revoke') {
    const append = input.ledger.append.bind(input.ledger);
    vi.spyOn(input.ledger, 'append').mockImplementation(async (entry) => {
      if (entry.kind === 'revoke') throw error;
      return append(entry);
    });
  } else if (failure === 'payment') {
    vi.spyOn(input.repo.payments, 'put').mockRejectedValue(error);
  } else {
    const put = input.repo.refunds.put.bind(input.repo.refunds);
    vi.spyOn(input.repo.refunds, 'put').mockImplementation(async (row) => {
      if (row.status === 'succeeded') throw error;
      return put(row);
    });
  }
  await expect(execute(input)).rejects.toBe(error);
  expect((await input.repo.refunds.list())[0].status).toBe('pending');
  vi.restoreAllMocks();
  const result = await execute(input);
  expect(result.status).toBe('succeeded');
  expect(input.requests).toHaveLength(1);
  expect((await input.ledger.balance('cust_1', 'paid', input.clock.now())).available).toBe(0);
  expect(await input.repo.refunds.list()).toHaveLength(1);
});

it('does not retry provider when saving the successful provider checkpoint fails', async () => {
  const input = await setup();
  const put = input.repo.operations.put.bind(input.repo.operations);
  vi.spyOn(input.repo.operations, 'put').mockImplementation(async (operation) => {
    if (operation.kind === 'refund.provider' && operation.status === 'done') throw new Error('checkpoint unavailable');
    return put(operation);
  });
  await expect(execute(input)).rejects.toThrow('checkpoint unavailable');
  vi.restoreAllMocks();
  const pending = await execute(input);
  expect(pending.status).toBe('pending');
  expect(input.requests).toHaveLength(1);
  expect((await input.ledger.balance('cust_1', 'paid', input.clock.now())).available).toBe(0);
});

it('does not replace a reconciled refund with a stale submitted checkpoint', async () => {
  const input = await setup();
  const put = input.repo.operations.put.bind(input.repo.operations);
  vi.spyOn(input.repo.operations, 'put').mockImplementation(async (operation) => {
    if (operation.kind === 'refund.provider' && operation.status === 'done') throw new Error('checkpoint unavailable');
    return put(operation);
  });
  await expect(execute(input)).rejects.toThrow('checkpoint unavailable');
  vi.restoreAllMocks();
  const pending = (await input.repo.refunds.list())[0];
  const reconciled: Refund = { ...pending, status: 'failed', failure: null };
  await input.repo.refunds.put(reconciled);
  expect(await execute(input)).toEqual(reconciled);
  expect(input.requests).toHaveLength(1);
});

it.each(['pending', 'succeeded'] as const)('preserved %s partial-refund checkpoint survives outer operation retention', async (status) => {
  const input = await setup();
  input.decision = { ...input.decision, amount: { amountMinor: 400, currency: 'USD' }, creditsToRevoke: 40 };
  input.provider.refund.mockResolvedValue({ id: 'provider_refund', paymentId: 'pay_1', customerId: 'cust_1',
    amount: input.decision.amount, status, providerRef: 'provider_refund', creditsRevoked: 0,
    ruleId: 'D1', reason: null, failure: null, createdAt: input.clock.now() });
  const first = await execute(input);
  const retained = (await input.repo.operations.list()).filter((row) => row.kind === 'refund.provider');
  expect(retained).toHaveLength(1);
  // Simulate generic retention deleting the outer replay receipt but retaining money-request identity.
  input.repo.operations = new InMemoryRepo().operations;
  for (const row of retained) await input.repo.operations.put(row);
  input.clock.advance(8 * 86_400_000);
  expect(await execute(input)).toEqual(first);
  expect(input.provider.refund).toHaveBeenCalledTimes(1);
  expect(await input.repo.refunds.list()).toHaveLength(1);
  expect((await input.ledger.balance('cust_1', 'paid', input.clock.now())).available).toBe(60);
});
