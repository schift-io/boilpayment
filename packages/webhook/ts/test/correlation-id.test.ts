// [EC:L5] correlationId propagation — follows ONE id from receive() (where it's minted) through
// process() (where it's read back off the record and threaded into HandlerCtx) into a ledger
// entry's `reference.correlationId` (via handlers.ts wrapping the `ledger` dep, transparent to
// lifecycle) and into every `webhook.*` audit log line for the delivery (via CollectingLogger —
// PostgresLogger promoting `fields.correlationId` to the `audit_log.correlation_id` column is
// already proven separately in packages/schema-postgres, see spec/schema-postgres.pseudo.md
// [EC:L1-L5] "Smoke-tested 2026-09-09").
import { describe, expect, it } from 'vitest';
import { CollectingLogger, DEFAULT_POLICY, FixedClock, InMemoryLedger, InMemoryRepo, SequentialIdGen } from 'boilpayment-core';
import type { Payment, Subscription } from 'boilpayment-core';
import type { LifecycleDeps } from '../src/index.js';
import { defaultHandlers, mintCorrelationId, process as processWebhook, receive } from '../src/index.js';
import { FakeProvider, jsonVerify } from './helpers.js';

describe('[EC:L5] correlationId propagation — receive -> process -> ledger entry -> audit log', () => {
  it('the same correlationId shows up on the webhook record, both log lines, and the ledger entry reference', async () => {
    const clock = new FixedClock(new Date('2026-01-01T00:00:00Z'));
    const repo = new InMemoryRepo();
    const ledger = new InMemoryLedger(new SequentialIdGen('led_'));
    const logger = new CollectingLogger();

    const sub: Subscription = {
      id: 'sub1', customerId: 'cust1', planId: 'planA', provider: 'stripe', providerRef: 'sub_1',
      status: 'active', currentPeriod: { start: clock.now(), end: new Date('2026-02-01T00:00:00Z') },
      anchorDay: 1, cancelAtPeriodEnd: false, graceUntil: null, billingKey: null, scheduledPlanId: null, createdAt: clock.now(),
    };
    const payment: Payment = {
      id: 'pay1', customerId: 'cust1', provider: 'stripe', providerRef: 'pay_1', subscriptionId: 'sub1',
      amount: { amountMinor: 1000, currency: 'USD' }, status: 'succeeded', kind: 'subscription',
      period: sub.currentPeriod, occurredAt: clock.now(), failure: null,
    };
    await repo.subscriptions.put(sub);
    await repo.payments.put(payment);

    const provider = new FakeProvider({ verify: jsonVerify(), getPaymentImpl: () => payment, getSubscriptionImpl: () => sub });

    // Fake lifecycle.onRenewalPaid appends via `input.ledger` — handlers.ts hands it the
    // correlationId-wrapping decorator, so this real ledger.append() call, made by a dep that has
    // NO idea correlationId exists, still ends up tagging the entry.
    const lifecycle: LifecycleDeps = {
      onRenewalPaid: async (input) => {
        await input.ledger.append({
          customerId: input.payment.customerId, pool: 'paid', kind: 'grant', amount: 100,
          unitPriceMinor: null, currency: null, expiresAt: null, source: 'subscription',
          reference: { subscriptionId: input.sub.id, paymentId: input.payment.id },
          idempotencyKey: `renewal:${input.payment.id}`, actor: 'system', reason: null,
        });
      },
      dunning: { onPaymentFailed: async () => {} },
    };
    const handlers = defaultHandlers({ policy: DEFAULT_POLICY, ledger, repo, notifier: { send: async () => {} }, clock, ids: new SequentialIdGen('id_'), lifecycle });

    const rawBody = JSON.stringify({
      id: 'evt_corr_1', type: 'payment.succeeded', occurredAt: clock.now().toISOString(),
      subscriptionRef: sub.providerRef, paymentRef: payment.providerRef,
    });

    const expectedCorrelationId = mintCorrelationId('evt_corr_1');

    const r1 = await receive({ provider, headers: { 'x-sig': 'ok' }, rawBody, repo, clock, logger });
    expect(r1.eventId).toBe('evt_corr_1');

    // 1) minted at receive() and persisted on the WebhookEventRecord
    const record = await repo.webhookEvents.get('evt_corr_1');
    expect(record?.correlationId).toBe(expectedCorrelationId);

    // 2) the receive() log line carries it
    const receivedLog = logger.entries.find((e) => e.event === 'webhook.received');
    expect(receivedLog?.correlationId).toBe(expectedCorrelationId);

    await processWebhook({ eventId: r1.eventId!, providers: { stripe: provider }, handlers, repo, clock, logger });

    // 3) both process() log lines carry the SAME id
    const processingLog = logger.entries.find((e) => e.event === 'webhook.processing');
    const processedLog = logger.entries.find((e) => e.event === 'webhook.processed');
    expect(processingLog?.correlationId).toBe(expectedCorrelationId);
    expect(processedLog?.correlationId).toBe(expectedCorrelationId);

    // 4) the ledger entry lifecycle.onRenewalPaid wrote carries it too — end to end.
    const entries = await ledger.entries('cust1');
    const grant = entries.find((e) => e.idempotencyKey === 'renewal:pay1');
    expect(grant?.reference.correlationId).toBe(expectedCorrelationId);
  });
});
