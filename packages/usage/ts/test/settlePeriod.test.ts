import { expect, it } from 'vitest';
import { settleDuePeriods, settlePeriod } from '../src/index.js';
import { FakeProvider } from './fixtures.js';
import { given } from './settlementFixtures.js';

it('charges the closed period once and persists the provider payment', async () => {
  const input = await given();
  const first = await settlePeriod(input);
  const replay = await settlePeriod(input);
  expect(first.status).toBe('charged');
  expect(replay.status).toBe('unchanged');
  expect(input.provider.calls).toEqual([{ amount: { amountMinor: 750, currency: 'KRW' }, key: input.provider.calls[0]?.key, customerRef: 'provider_customer' }]);
  expect(await input.repo.payments.list()).toMatchObject([{ kind: 'overage', subscriptionId: input.sub.id, status: 'succeeded', amount: { amountMinor: 750, currency: 'KRW' }, period: input.period }]);
});

it('never charges before the period ends', async () => {
  const input = await given();
  input.clock.advance(-1);
  expect((await settlePeriod(input)).status).toBe('not_due');
  expect(input.provider.calls).toHaveLength(0);
});

it('preserves an unknown outcome and retries its original key before billing late deltas', async () => {
  const input = await given();
  input.provider.loseResponse = true;
  await expect(settlePeriod(input)).rejects.toThrow('connection lost');
  expect(await input.repo.operations.list()).toMatchObject([{ status: 'in_progress' }]);
  await input.repo.usageEvents.put({ id: 'late', customerId: input.sub.customerId, meter: 'call', quantity: 2, occurredAt: input.period.start, receivedAt: input.clock.now(), periodStart: input.period.start, idempotencyKey: 'late', meta: null });
  input.clock.advance(300_000);
  expect((await settlePeriod(input)).status).toBe('charged');
  expect(input.provider.calls[1]).toEqual(input.provider.calls[0]);
  expect((await settlePeriod(input)).chargedAmount).toEqual({ amountMinor: 500, currency: 'KRW' });
  expect(input.provider.charges.size).toBe(2);
});

it('reconciles pending provider payment without creating another charge', async () => {
  const input = await given();
  input.provider.status = 'pending';
  expect((await settlePeriod(input)).status).toBe('pending');
  input.provider.status = 'succeeded';
  input.clock.advance(300_000);
  expect((await settlePeriod(input)).status).toBe('charged');
  expect(input.provider.calls).toHaveLength(1);
});

it('keeps failed settlement unpaid without inventing success on retry', async () => {
  const input = await given();
  input.provider.status = 'failed';
  expect((await settlePeriod(input)).status).toBe('failed');
  expect((await settlePeriod(input)).status).toBe('failed');
  expect(input.provider.calls).toHaveLength(1);
});

it('refuses direct charges when usage was already routed to provider meters', async () => {
  const input = await given();
  await input.repo.outbox.put({ id: 'report', kind: 'usage.report', payload: { eventId: 'event' }, status: 'sent', attempts: 1, nextAttemptAt: input.clock.now(), createdAt: input.clock.now() });
  await expect(settlePeriod(input)).rejects.toMatchObject({ code: 'unsupported_usage_billing' });
  expect(input.provider.calls).toHaveLength(0);
});

it('serializes concurrent cron attempts into one charge', async () => {
  const input = await given();
  const results = await Promise.all([settlePeriod(input), settlePeriod(input)]);
  expect(results.filter((result) => result.status === 'charged')).toHaveLength(1);
  expect(results.every((result) => ['charged', 'pending', 'unchanged'].includes(result.status))).toBe(true);
  expect(input.provider.calls).toHaveLength(1);
});

it('recovers a succeeded payment when saving its checkpoint failed', async () => {
  const input = await given();
  const put = input.repo.operations.put.bind(input.repo.operations);
  let failOnce = true;
  input.repo.operations.put = async (row) => {
    if (failOnce && row.status === 'done') { failOnce = false; throw new Error('checkpoint unavailable'); }
    return put(row);
  };
  await expect(settlePeriod(input)).rejects.toThrow('checkpoint unavailable');
  expect((await input.repo.payments.list())[0]?.status).toBe('succeeded');
  input.clock.advance(300_000);
  expect((await settlePeriod(input)).status).toBe('charged');
  expect(input.provider.calls).toHaveLength(1);
});

it('discovers the original usage period after the subscription renews', async () => {
  const input = await given();
  await input.repo.payments.put({ id: 'invoice', customerId: input.sub.customerId, provider: input.provider.name, providerRef: 'invoice_ref', subscriptionId: input.sub.id, amount: { amountMinor: 1000, currency: 'KRW' }, status: 'succeeded', kind: 'subscription', period: input.period, occurredAt: input.period.start, failure: null, cashReceipt: null });
  await input.repo.subscriptions.put({ ...input.sub, currentPeriod: { start: input.period.end, end: new Date('2026-07-01T00:00:00Z') } });
  const batch = { ...input, providers: { stripe: input.provider } };
  const results = await settleDuePeriods(batch);
  expect(results).toMatchObject([{ subscriptionId: input.sub.id, period: input.period, result: { status: 'charged' } }]);
  expect((await settleDuePeriods(batch))[0]?.result.status).toBe('unchanged');
  expect(input.provider.calls).toHaveLength(1);
});

it('rejects changed rules while an original charge is unresolved', async () => {
  const input = await given();
  input.provider.loseResponse = true;
  await expect(settlePeriod(input)).rejects.toThrow('connection lost');
  const policy = { ...input.policy, usage: { ...input.policy.usage, overageUnitPriceMinor: 500 } };
  await expect(settlePeriod({ ...input, policy })).rejects.toMatchObject({ code: 'usage_billing_policy_changed' });
  expect(input.provider.calls).toHaveLength(1);
});

it('reports native metered usage once without claiming payment or charging a billing key', async () => {
  const input = await given();
  const provider = new FakeProvider();
  const first = await settlePeriod({ ...input, provider });
  const replay = await settlePeriod({ ...input, provider });
  expect(first.status).toBe('awaiting_provider_billing');
  expect(replay.status).toBe('awaiting_provider_billing');
  expect(first.chargedAmount).toBeNull();
  expect(provider.reportUsageCalls).toEqual([{ customerRef: 'provider_customer', meter: 'call', quantity: 8 }]);
  expect(await input.repo.payments.list()).toEqual([]);
  expect(await input.repo.outbox.list()).toMatchObject([{ kind: 'usage.report', status: 'sent' }]);
});

it('keeps failed native meter delivery pending for retry', async () => {
  const input = await given();
  const provider = new FakeProvider({ alwaysFail: true });
  expect((await settlePeriod({ ...input, provider })).status).toBe('report_pending');
  expect(await input.repo.payments.list()).toEqual([]);
  expect(await input.repo.outbox.list()).toMatchObject([{ status: 'pending', attempts: 1 }]);
});

it('restores persisted JSON report timestamps before calling the provider', async () => {
  const input = await given();
  class DateCheckingProvider extends FakeProvider {
    async reportUsage(report: { meter: string; customerRef: string; quantity: number; occurredAt: Date }): Promise<void> {
      expect(report.occurredAt).toBeInstanceOf(Date);
      await super.reportUsage(report);
    }
  }
  await input.repo.outbox.put({ id: 'persisted', kind: 'usage.report', payload: { eventId: 'event', customerId: input.sub.customerId, meter: 'call', quantity: 8, occurredAt: input.period.start.toISOString(), provider: 'stripe' }, status: 'pending', attempts: 0, nextAttemptAt: input.clock.now(), createdAt: input.clock.now() });
  expect((await settlePeriod({ ...input, provider: new DateCheckingProvider() })).status).toBe('awaiting_provider_billing');
});

it('rejects alternate period ends and ambiguous direct subscription ownership', async () => {
  const input = await given();
  await expect(settlePeriod({ ...input, period: { ...input.period, end: new Date('2026-05-31T00:00:00Z') } })).rejects.toMatchObject({ code: 'invalid_usage_period' });
  await input.repo.subscriptions.put({ ...input.sub, id: 'other-sub' });
  await expect(settlePeriod(input)).rejects.toMatchObject({ code: 'ambiguous_usage_subscription' });
  expect(input.provider.calls).toHaveLength(0);
});

it('uses original paid invoice currency for historical usage after a plan change', async () => {
  const input = await given();
  await input.repo.payments.put({ id: 'invoice', customerId: input.sub.customerId, provider: input.provider.name, providerRef: 'invoice_ref', subscriptionId: input.sub.id, amount: { amountMinor: 1000, currency: 'KRW' }, status: 'succeeded', kind: 'subscription', period: input.period, occurredAt: input.period.start, failure: null, cashReceipt: null });
  const plan = await input.repo.plans.get(input.sub.planId);
  if (!plan) throw new Error('missing fixture plan');
  await input.repo.plans.put({ ...plan, interval: 'year', prices: [{ currency: 'USD', amountMinor: 1000 }] });
  const sub = { ...input.sub, currentPeriod: { start: input.period.end, end: new Date('2027-06-01T00:00:00Z') } };
  expect((await settlePeriod({ ...input, sub })).chargedAmount).toEqual({ amountMinor: 750, currency: 'KRW' });
});

it('refuses to reconstruct unproven historical periods from the current plan', async () => {
  const input = await given();
  await input.repo.subscriptions.put({ ...input.sub, currentPeriod: { start: input.period.end, end: new Date('2026-07-01T00:00:00Z') } });
  await expect(settleDuePeriods({ ...input, providers: { stripe: input.provider } })).rejects.toMatchObject({ code: 'invalid_usage_period' });
  expect(input.provider.calls).toHaveLength(0);
});
