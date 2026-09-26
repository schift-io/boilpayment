// [EC:apiBase] Integration test against a REAL `stripe-mock` binary (https://github.com/stripe/stripe-mock),
// driven through `StripeProviderConfig.apiBase`. Unlike the other test files in this directory (which stub
// the transport), this file makes real HTTP calls to a locally running stripe-mock server and asserts on the
// shape it actually returns — this is what caught the "basil" API shape change (current_period_* moved from
// Subscription to SubscriptionItem) in the first place: stripe-mock 0.203.0's canned `GET /v1/subscriptions/:id`
// response has NO `current_period_start`/`current_period_end` on the subscription root, only on
// `items.data[0]`.
//
// Guarded: only runs if the `stripe-mock` binary is present on PATH (`which stripe-mock`). The suite starts
// its own stripe-mock child process on an OS-assigned port and stops only that process afterwards, so
// `pnpm -r test` never depends on a daemon the developer has to remember to start.
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { StripeProvider } from '../src/index.js';

const HOST = '127.0.0.1';

function hasStripeMockBinary(): boolean {
  try {
    execFileSync('which', ['stripe-mock'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

const available = hasStripeMockBinary();

function makeProvider(port: number): StripeProvider {
  return new StripeProvider({
    secretKey: 'sk_test_123', // stripe-mock only requires a valid-looking sk_test_ key, does not check it
    webhookSecret: 'whsec_unused_in_this_file',
    apiBase: { host: HOST, port, protocol: 'http' },
  });
}

describe.skipIf(!available)('[EC:apiBase] StripeProvider against real stripe-mock (isolated port)', () => {
  let child: ChildProcess | null = null;
  let port = 0;
  const ping = () => fetch(`http://${HOST}:${port}/v1/customers/cus_liveness_check`, {
    headers: { Authorization: 'Basic ' + Buffer.from('sk_test_liveness:').toString('base64') },
  });

  beforeAll(async () => {
    let startup = '';
    child = spawn('stripe-mock', ['-http-port', '0'], { stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => {
      startup += chunk;
      const match = /Listening for HTTP at address: .*:(\d+)/.exec(startup);
      if (match?.[1]) port = Number(match[1]);
    });
    const deadline = Date.now() + 8000;
    while (Date.now() < deadline) {
      if (child.exitCode !== null) throw new Error(`stripe-mock exited during startup: ${startup}`);
      if (port > 0 && await ping().then(() => true).catch(() => false)) return;
      await new Promise((r) => setTimeout(r, 150));
    }
    throw new Error(`stripe-mock did not start listening on ${HOST}:${port} within 8s`);
  }, 15_000);

  afterAll(() => {
    if (child) child.kill();
  });

  it('[EC:apiBase] createCustomer round-trips through real stripe-mock and returns a cus_ ref', async () => {
    const provider = makeProvider(port);
    const { ref } = await provider.createCustomer({ email: 'mock-integration@example.com', name: 'Mock Test' });
    expect(ref).toMatch(/^cus_/);
  });

  it('[EC:F(Stripe)] getSubscription against real stripe-mock derives currentPeriod from items[0] (live basil shape, not a hand-written fixture)', async () => {
    const provider = makeProvider(port);
    const sub = await provider.getSubscription('sub_mock_1');
    expect(sub.id).toBe('sub_mock_1');
    expect(sub.provider).toBe('stripe');
    expect(sub.currentPeriod.start).toBeInstanceOf(Date);
    expect(sub.currentPeriod.end).toBeInstanceOf(Date);
    // stripe-mock's canned subscription fixture has no current_period_* on the root object as of 0.203.x —
    // if this ever starts failing because current_period_start reappears at the root, that's fine too
    // (normalizeSubscription prefers the root value when present); the real invariant under test is that
    // normalizeSubscription does NOT throw provider_shape against a live server's actual response shape.
    expect(sub.currentPeriod.start.getTime()).toBeGreaterThan(0);
    expect(sub.currentPeriod.end.getTime()).toBeGreaterThan(0);
  });

  it('[EC:E7 E12] getPayment("pi_...") round-trips through real stripe-mock', async () => {
    const provider = makeProvider(port);
    const payment = await provider.getPayment('pi_mock_1');
    expect(payment.id).toBe('pi_mock_1');
    expect(payment.provider).toBe('stripe');
    expect(typeof payment.amount.amountMinor).toBe('number');
  });

  it('[EC:F(Stripe)] getPayment("in_...") round-trips through real stripe-mock (invoice fetch, no expand=payment_intent, optional separate PI fetch)', async () => {
    const provider = makeProvider(port);
    const payment = await provider.getPayment('in_mock_1');
    expect(payment.id).toBe('in_mock_1');
    expect(payment.kind).toBe('subscription');
    expect(payment.provider).toBe('stripe');
  });
});
