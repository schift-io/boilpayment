import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { CollectingNotifier, DEFAULT_POLICY, FixedClock, InMemoryLedger, InMemoryRepo, SequentialIdGen } from 'boilpayment-core';
import type { PaymentProvider, ProviderName, Refund } from 'boilpayment-core';
import { StripeProvider } from '../../../providers/stripe/ts/src/index.js';
import { PolarProvider } from '../../../providers/polar/ts/src/index.js';
import { TossProvider } from '../../../providers/toss/ts/src/index.js';
import { PortoneProvider } from '../../../providers/portone/ts/src/index.js';
import { onExternalRefund } from '../../../refund/ts/src/index.js';
import { defaultHandlers, receive, process as processWebhook } from '../src/index.js';

const secret = 'whsec_' + Buffer.from('settlement-test-secret').toString('base64');

function delivery(name: ProviderName, status: Refund['status']) {
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const id = `delivery-${name}-${status}`;
  let body: unknown;
  switch (name) {
    case 'stripe': body = { id, type: 'refund.updated', created: Number(timestamp), data: { object: { id: 'refund-1', object: 'refund', status, payment_intent: 'payment-1', amount: 1000, currency: 'usd' } } }; break;
    case 'polar': body = { type: 'refund.updated', timestamp: new Date().toISOString(), data: { id: 'refund-1', status, order_id: 'payment-1', amount: 1000, currency: 'usd', created_at: new Date().toISOString() } }; break;
    case 'toss': body = { eventType: 'CANCEL_STATUS_CHANGED', createdAt: new Date().toISOString(), data: { transactionKey: 'refund-1', cancelAmount: 1000, cancelStatus: 'DONE' } }; break;
    case 'portone': body = { type: 'Transaction.CancelPending', timestamp: new Date().toISOString(), data: { paymentId: 'payment-1', cancellationId: 'refund-1' } }; break;
  }
  const rawBody = JSON.stringify(body);
  const signature = createHmac('sha256', Buffer.from(secret.slice(6), 'base64')).update(`${id}.${timestamp}.${rawBody}`).digest('base64');
  const headers: Record<string, string> = {
    'webhook-id': id, 'webhook-timestamp': timestamp, 'webhook-signature': `v1,${signature}`,
    'stripe-signature': `t=${timestamp},v1=${createHmac('sha256', secret).update(`${timestamp}.${rawBody}`).digest('hex')}`,
    'x-paykit-remote-ip': '127.0.0.1',
  };
  return { rawBody, headers };
}

function providerFor(name: ProviderName, status: Refund['status']): PaymentProvider {
  const fetchImpl: typeof fetch = async () => new Response(JSON.stringify({
    id: 'payment-1', paymentKey: 'payment-1', currency: 'KRW',
    cancels: [{ transactionKey: 'refund-1', cancelAmount: 1000, cancelStatus: status === 'succeeded' ? 'DONE' : 'PENDING', canceledAt: new Date().toISOString() }],
    cancellations: [{ id: 'refund-1', status: status === 'succeeded' ? 'SUCCEEDED' : status === 'failed' ? 'FAILED' : 'REQUESTED', totalAmount: 1000, cancelledAt: new Date().toISOString() }],
  }), { status: 200 });
  switch (name) {
    case 'stripe': return new StripeProvider({ secretKey: 'sk_test_fixture', webhookSecret: secret });
    case 'polar': return new PolarProvider({ accessToken: 'fixture', webhookSecret: secret });
    case 'toss': return new TossProvider({ secretKey: 'test_sk_fixture', allowedWebhookIps: ['127.0.0.1'] }, fetchImpl);
    case 'portone': return new PortoneProvider({ apiSecret: 'fixture', storeId: 'fixture', webhookSecret: secret }, fetchImpl);
  }
}

describe('real normalized refund webhook completion', () => {
  for (const name of ['stripe', 'polar', 'toss', 'portone'] as const) {
    for (const status of ['succeeded', 'failed', 'pending'] as const) {
      it(`${name} ${status} preserves pending settlement and replay integrity`, async () => {
        // Given a known provider refund with its approved credit hold.
        const clock = new FixedClock(new Date());
        const ids = new SequentialIdGen('id');
        const repo = new InMemoryRepo();
        const ledger = new InMemoryLedger(ids);
        const currency = name === 'toss' || name === 'portone' ? 'KRW' : 'USD';
        await repo.payments.put({ id: 'local-payment', customerId: 'customer', provider: name, providerRef: 'payment-1', subscriptionId: null, amount: { amountMinor: 1000, currency }, status: 'succeeded', kind: 'topup', period: null, occurredAt: clock.now(), failure: null });
        await repo.refunds.put({ id: 'local-refund', paymentId: 'local-payment', customerId: 'customer', amount: { amountMinor: 1000, currency }, status: 'pending', providerRef: 'refund-1', creditsRevoked: 0, ruleId: 'D1', reason: null, failure: null, createdAt: clock.now() });
        for (const kind of ['grant', 'hold'] as const) await ledger.append({ customerId: 'customer', pool: 'paid', kind, amount: kind === 'grant' ? 100 : -100, source: kind === 'grant' ? 'topup' : 'refund', reference: { paymentId: 'local-payment', refundId: kind === 'hold' ? 'local-refund' : undefined }, idempotencyKey: kind, actor: 'system', reason: null, unitPriceMinor: 10, currency, expiresAt: null });
        const provider = providerFor(name, status);
        const notifier = new CollectingNotifier();
        const handlers = defaultHandlers({ policy: DEFAULT_POLICY, ledger, repo, notifier, clock, ids, refund: {
          onExternalRefund: async (input) => onExternalRefund({ ...input, cs: { openReconcileMismatchCase: async () => {} }, clock, ids }),
        } });
        // When actual signed verification (IP-checked for unsigned Toss) reaches the default handler and is replayed.
        const input = delivery(name, status);
        const received = await receive({ provider, ...input, repo, clock });
        expect(received.status).toBe(200);
        if (!received.eventId) throw new Error('missing verified event ID');
        for (let attempt = 0; attempt < 2; attempt++) await processWebhook({ eventId: received.eventId, providers: { [name]: provider }, handlers, repo, clock });
        // Then only authoritative terminal success/failure releases the original hold exactly once.
        const expected = name === 'toss' && status === 'failed' ? 'pending' : status;
        expect((await repo.webhookEvents.get(received.eventId))?.status).toBe('processed');
        expect((await repo.refunds.get('local-refund'))?.status).toBe(expected);
        expect(await repo.refunds.list()).toHaveLength(1);
        const balance = await ledger.balance('customer', 'paid', clock.now());
        expect(balance.held).toBeCloseTo(expected === 'pending' ? 100 : 0);
        expect(balance.available).toBe(expected === 'failed' ? 100 : 0);
        expect((await ledger.entries('customer', { kind: 'revoke' })).length).toBe(expected === 'succeeded' ? 1 : 0);
      });
    }
  }
});
