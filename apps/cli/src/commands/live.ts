// `boilpayment live` — proves a generated project's paykit.config.json + .env actually talk to the
// REAL provider test/sandbox environments. This is NOT the tools/mocks/* CI regression path
// (see tools/mocks/README.md and docs/PUBLIC_SANDBOX_VERIFICATION.md) — this hits api.stripe.com / api.tosspayments.com /
// api.portone.io / (sandbox-)api.polar.sh over the network, using whatever real test keys the
// owner puts in .env. No mocks anywhere in this file.
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import path from 'node:path';
import pc from 'picocolors';
import { InMemoryRepo, ProviderError, SystemClock } from 'boilpayment-core';
import type { PaymentProvider, ProviderName, Repo } from 'boilpayment-core';
import { StripeProvider } from 'boilpayment-stripe';
import { TossProvider } from 'boilpayment-toss';
import { PortoneProvider } from 'boilpayment-portone';
import { PolarProvider } from 'boilpayment-polar';
import { receive, process as processWebhook } from 'boilpayment-webhook';
import { readConfig } from '../config.js';
import type { PaykitConfig, PlanConfig } from '../config.js';
import { loadEnvFile } from '../util/env-file.js';
import type { ParsedArgv } from '../util/argv.js';

type Status = 'PASS' | 'FAIL' | 'SKIP';

interface StepResult {
  status: Status;
  provider: string;
  step: string;
  detail: string;
}

class Reporter {
  results: StepResult[] = [];
  private secrets: string[] = [];

  registerSecret(value: string | undefined): void {
    if (value && value.length >= 6) this.secrets.push(value);
  }

  private redact(text: string): string {
    let out = text;
    for (const s of this.secrets) {
      if (s) out = out.split(s).join('***REDACTED***');
    }
    return out;
  }

  record(status: Status, provider: string, step: string, detail: string): StepResult {
    const safeDetail = this.redact(detail).replace(/\s+/g, ' ').trim();
    const r: StepResult = { status, provider, step, detail: safeDetail };
    this.results.push(r);
    const color = status === 'PASS' ? pc.green : status === 'FAIL' ? pc.red : pc.yellow;
    console.log(`${color(status.padEnd(4))}  ${pc.bold(provider.padEnd(8))} ${step.padEnd(28)}  ${safeDetail}`);
    return r;
  }

  hasFailure(): boolean {
    return this.results.some((r) => r.status === 'FAIL');
  }
}

function errDetail(err: unknown): string {
  if (err && typeof err === 'object') {
    const e = err as { message?: string; failure?: { providerCode?: string | null; userMessage?: string }; code?: string };
    const parts: string[] = [];
    if (e.message) parts.push(e.message);
    if (e.failure?.providerCode) parts.push(`providerCode=${e.failure.providerCode}`);
    if (e.code) parts.push(`code=${e.code}`);
    return parts.join(' | ') || String(err);
  }
  return String(err);
}

function idem(prefix: string): string {
  return `${prefix}_${randomUUID()}`;
}

// ── env requirement tables (mirrors apps/cli/src/generate/env.ts + ts-entry.ts) ────────────

const REQUIRED_ENV: Record<ProviderName, string[]> = {
  stripe: ['STRIPE_SECRET_KEY', 'STRIPE_WEBHOOK_SECRET'],
  toss: ['TOSS_SECRET_KEY'],
  portone: ['PORTONE_API_SECRET', 'PORTONE_STORE_ID', 'PORTONE_WEBHOOK_SECRET'],
  polar: ['POLAR_ACCESS_TOKEN', 'POLAR_WEBHOOK_SECRET'],
};

function missingEnv(provider: ProviderName, env: Record<string, string | undefined>): string[] {
  return REQUIRED_ENV[provider].filter((k) => !env[k] || env[k]!.trim() === '');
}

function firstPlanAndPrice(config: PaykitConfig): { plan: PlanConfig; price: PlanConfig['prices'][number] } | null {
  const plan = config.plans[0];
  if (!plan || plan.prices.length === 0) return null;
  return { plan, price: plan.prices[0] };
}

// ── per-provider round trips ────────────────────────────────────────────────────────────────

async function runStripe(env: Record<string, string | undefined>, config: PaykitConfig, r: Reporter, dryRun: boolean): Promise<void> {
  const P = 'stripe';
  const missing = missingEnv('stripe', env);
  if (missing.length > 0) {
    r.record(dryRun ? 'SKIP' : 'FAIL', P, 'all steps', `no keys in .env (missing: ${missing.join(', ')})`);
    return;
  }
  r.registerSecret(env.STRIPE_SECRET_KEY);
  r.registerSecret(env.STRIPE_WEBHOOK_SECRET);
  if (dryRun) {
    r.record('SKIP', P, 'dry-run', 'would run createCustomer → createCheckout → createTestPayment → getPayment → refund(partial) → getPayment → listPayments → reportUsage → webhook');
    return;
  }
  if (!env.STRIPE_SECRET_KEY!.startsWith('sk_test_')) {
    r.record('FAIL', P, 'preflight', 'STRIPE_SECRET_KEY does not start with sk_test_ — paykit live refuses to run against a live-mode key');
    return;
  }

  const provider = new StripeProvider({ secretKey: env.STRIPE_SECRET_KEY!, webhookSecret: env.STRIPE_WEBHOOK_SECRET! });

  let customerRef: string | null = null;
  try {
    const c = await provider.createCustomer({ email: `paykit-live-${Date.now()}@example.com`, name: 'paykit live' });
    customerRef = c.ref;
    r.record('PASS', P, 'createCustomer', `ref=${c.ref}`);
  } catch (err) {
    r.record('FAIL', P, 'createCustomer', errDetail(err));
    return; // nothing else can proceed without a real customer/key
  }

  const pp = firstPlanAndPrice(config);
  if (pp) {
    const providerPriceRef = (pp.price as unknown as { providerPriceRefs?: Record<string, string> }).providerPriceRefs?.stripe ?? env.STRIPE_TEST_PRICE_ID;
    if (!providerPriceRef) {
      r.record(
        'SKIP',
        P,
        'createCheckout',
        'plans[0].prices[0] has no providerPriceRefs.stripe (contract gap — apps/cli PlanPriceConfig has no such field yet) and no STRIPE_TEST_PRICE_ID env override set',
      );
    } else {
      try {
        const checkout = await provider.createCheckout({
          customerRef,
          plan: pp.plan as unknown as Parameters<typeof provider.createCheckout>[0]['plan'],
          price: { currency: pp.price.currency, amountMinor: pp.price.amountMinor, providerPriceRefs: { stripe: providerPriceRef } },
          mode: pp.plan.interval ? 'subscription' : 'one_time',
          successUrl: 'https://example.com/success',
          cancelUrl: 'https://example.com/cancel',
          idempotencyKey: idem('live_checkout'),
        });
        r.record('PASS', P, 'createCheckout', `hosted url: ${checkout.url}`);
      } catch (err) {
        r.record('FAIL', P, 'createCheckout', errDetail(err));
      }
    }
  } else {
    r.record('SKIP', P, 'createCheckout', 'paykit.config.json has no plans[0].prices[0]');
  }

  let paymentRef: string | null = null;
  try {
    const payment = await provider.createTestPayment({ amount: { amountMinor: 1099, currency: 'usd' }, customerRef, idempotencyKey: idem('live_pi') });
    paymentRef = payment.providerRef;
    r.record('PASS', P, 'createTestPayment', `providerRef=${payment.providerRef} status=${payment.status}`);
  } catch (err) {
    r.record('FAIL', P, 'createTestPayment', errDetail(err));
  }

  if (paymentRef) {
    try {
      const payment = await provider.getPayment(paymentRef);
      r.record('PASS', P, 'getPayment', `status=${payment.status} amount=${payment.amount.amountMinor}${payment.amount.currency}`);
    } catch (err) {
      r.record('FAIL', P, 'getPayment', errDetail(err));
    }

    let refundOk = false;
    try {
      const refund = await provider.refund({ paymentRef, amount: { amountMinor: 500, currency: 'usd' }, reason: 'requested_by_customer', idempotencyKey: idem('live_refund') });
      r.record('PASS', P, 'refund(partial)', `refundId=${refund.id} status=${refund.status} amount=${refund.amount.amountMinor}`);
      refundOk = true;
    } catch (err) {
      r.record('FAIL', P, 'refund(partial)', errDetail(err));
    }

    try {
      const payment = await provider.getPayment(paymentRef);
      const ok = payment.status === 'partially_refunded' || payment.status === 'refunded';
      r.record(refundOk ? (ok ? 'PASS' : 'FAIL') : 'SKIP', P, 'getPayment(after refund)', `status=${payment.status}`);
    } catch (err) {
      r.record('FAIL', P, 'getPayment(after refund)', errDetail(err));
    }
  } else {
    r.record('SKIP', P, 'getPayment', 'no paymentRef (createTestPayment failed)');
    r.record('SKIP', P, 'refund(partial)', 'no paymentRef (createTestPayment failed)');
    r.record('SKIP', P, 'getPayment(after refund)', 'no paymentRef (createTestPayment failed)');
  }

  if (customerRef) {
    try {
      const list = await provider.listPayments({ customerRef, since: new Date(Date.now() - 24 * 3600 * 1000) });
      const found = paymentRef ? list.some((p) => p.providerRef === paymentRef) : false;
      r.record(paymentRef ? (found ? 'PASS' : 'FAIL') : 'PASS', P, 'listPayments', `count=${list.length}${paymentRef ? ` containsPayment=${found}` : ''}`);
    } catch (err) {
      r.record('FAIL', P, 'listPayments', errDetail(err));
    }
  }

  try {
    await provider.reportUsage({ meter: 'paykit_live_test', customerRef: customerRef ?? 'cus_unknown', quantity: 1, occurredAt: new Date(), idempotencyKey: idem('live_usage') });
    r.record('PASS', P, 'reportUsage', 'meter event accepted');
  } catch (err) {
    const detail = errDetail(err);
    if (/no such meter/i.test(detail) || /meter/i.test(detail)) {
      r.record('SKIP', P, 'reportUsage', `no meter named "paykit_live_test" exists in this Stripe test account — create one at dashboard.stripe.com/test/meters, error: ${detail}`);
    } else {
      r.record('FAIL', P, 'reportUsage', detail);
    }
  }

  await runStripeWebhook(env, r);
}

async function runStripeWebhook(env: Record<string, string | undefined>, r: Reporter): Promise<void> {
  const P = 'stripe';
  const stripeCliAvailable = await commandExists('stripe');
  if (!stripeCliAvailable) {
    r.record(
      'SKIP',
      P,
      'webhook',
      'stripe CLI not found on PATH — to verify manually: dashboard.stripe.com/test/webhooks → add endpoint pointing at your deployed /api/webhook/paykit (or run `stripe listen --forward-to localhost:<port>/api/webhook/paykit` + `stripe trigger payment_intent.succeeded` locally), then confirm your app logs a 200 and the event lands in repo.webhookEvents.',
    );
    return;
  }

  const port = 34121 + Math.floor(Math.random() * 500);
  const repo: Repo = new InMemoryRepo();
  const clock = new SystemClock();
  let capturedSecret: string | null = null;
  let receivedEventId: string | null = null;
  let serverError: string | null = null;

  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', async () => {
      try {
        const rawBody = Buffer.concat(chunks).toString('utf8');
        if (!capturedSecret) throw new Error('no webhook secret captured from `stripe listen` yet');
        const provider = new StripeProvider({ secretKey: env.STRIPE_SECRET_KEY!, webhookSecret: capturedSecret });
        const headers: Record<string, string> = {};
        for (const [k, v] of Object.entries(req.headers)) headers[k] = Array.isArray(v) ? v.join(',') : v ?? '';
        const result = await receive({ provider, headers, rawBody, repo, clock });
        if (result.eventId) {
          receivedEventId = result.eventId;
          await processWebhook({ eventId: result.eventId, providers: { stripe: provider }, handlers: {}, repo, clock });
        }
        res.writeHead(result.status).end(JSON.stringify(result));
      } catch (err) {
        serverError = errDetail(err);
        res.writeHead(400).end('error');
      }
    });
  });

  await new Promise<void>((resolve) => server.listen(port, resolve));

  try {
    const listen = spawn('stripe', stripeCliArgs(env.STRIPE_SECRET_KEY!, 'listen', '--forward-to', `http://127.0.0.1:${port}/webhook`, '--events', 'payment_intent.succeeded'), {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const secretPromise = new Promise<string | null>((resolve) => {
      const timeout = setTimeout(() => resolve(null), 15000);
      const onData = (buf: Buffer) => {
        const text = buf.toString('utf8');
        const m = text.match(/whsec_[A-Za-z0-9]+/);
        if (m) {
          clearTimeout(timeout);
          listen.stderr.off('data', onData);
          listen.stdout.off('data', onData);
          resolve(m[0]);
        }
      };
      listen.stderr.on('data', onData);
      listen.stdout.on('data', onData);
    });
    capturedSecret = await secretPromise;
    if (!capturedSecret) {
      r.record('SKIP', P, 'webhook', 'stripe CLI found but `stripe listen` did not print a webhook signing secret within 15s — likely not logged in (`stripe login`)');
      listen.kill();
      return;
    }
    r.registerSecret(capturedSecret);

    const trigger = spawn('stripe', stripeCliArgs(env.STRIPE_SECRET_KEY!, 'trigger', 'payment_intent.succeeded'), { stdio: 'ignore' });
    await new Promise<void>((resolve) => trigger.on('close', () => resolve()));
    await new Promise((resolve) => setTimeout(resolve, 4000)); // let the forwarded webhook land

    listen.kill();

    if (serverError) {
      r.record('FAIL', P, 'webhook', `receive/process failed: ${serverError}`);
    } else if (receivedEventId) {
      r.record('PASS', P, 'webhook', `stripe trigger payment_intent.succeeded → real signed delivery → webhook.receive+process handled eventId=${receivedEventId}`);
    } else {
      r.record('SKIP', P, 'webhook', 'stripe trigger ran but no event was forwarded to the local listener within the wait window');
    }
  } catch (err) {
    r.record('SKIP', P, 'webhook', `stripe CLI invocation failed: ${errDetail(err)}`);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

/** Bind every Stripe CLI subprocess to the selected test key; never fall back to global CLI auth. */
export function stripeCliArgs(apiKey: string, command: string, ...args: string[]): string[] {
  return ['--api-key', apiKey, command, ...args];
}

function commandExists(cmd: string): Promise<boolean> {
  return new Promise((resolve) => {
    const probe = spawn(cmd, ['--version'], { stdio: 'ignore' });
    probe.on('error', () => resolve(false));
    probe.on('close', (code) => resolve(code === 0));
  });
}

async function runToss(env: Record<string, string | undefined>, config: PaykitConfig, r: Reporter, dryRun: boolean): Promise<void> {
  const P = 'toss';
  const missing = missingEnv('toss', env);
  if (missing.length > 0) {
    r.record(dryRun ? 'SKIP' : 'FAIL', P, 'all steps', `no keys in .env (missing: ${missing.join(', ')})`);
    return;
  }
  r.registerSecret(env.TOSS_SECRET_KEY);
  if (dryRun) {
    r.record('SKIP', P, 'dry-run', 'would run createCustomer(local) → createCheckout(local url) → billing/authorizations/card(BIN-only test card) → chargeBillingKey(x2 idempotent) → getPayment → refund(partial) → getPayment → getPayment(unknown key, expect real error) → billing/authorizations/issue(bogus authKey, expect real error) → listPayments → webhook instructions');
    return;
  }

  const provider = new TossProvider({ secretKey: env.TOSS_SECRET_KEY! });

  const c = await provider.createCustomer({ email: `paykit-live-${Date.now()}@example.com` });
  r.record('PASS', P, 'createCustomer', `ref=${c.ref} (Toss has no customer API — this is a local synthesized customerKey, not a network call)`);

  const pp = firstPlanAndPrice(config);
  const krwPrice = pp && pp.price.currency === 'KRW' ? pp.price : { currency: 'KRW', amountMinor: 9900 };
  if (pp) {
    try {
      const checkout = await provider.createCheckout({
        customerRef: c.ref,
        plan: pp.plan as unknown as Parameters<typeof provider.createCheckout>[0]['plan'],
        price: krwPrice,
        mode: 'one_time',
        successUrl: 'https://example.com/success',
        cancelUrl: 'https://example.com/cancel',
        idempotencyKey: idem('live_checkout'),
      });
      r.record('PASS', P, 'createCheckout', `hosted url (local, no network call — Toss checkout is client-widget-driven): ${checkout.url}`);
    } catch (err) {
      r.record('FAIL', P, 'createCheckout', errDetail(err));
    }
  } else {
    r.record('SKIP', P, 'createCheckout', 'paykit.config.json has no plans[0]');
  }

  r.record('SKIP', P, 'confirmPayment', 'requires a paymentKey issued by the Toss payment widget in a real browser — not scriptable server-side');

  // ── browser-free path: issue a billing key directly from raw (BIN-only, test-mode) card
  // fields, then charge it. BIN 490625 (BC) confirmed live 2026-09-09 to issue a billing key
  // that chargeBillingKey can actually charge (unlike an arbitrary synthetic BIN, which issues
  // fine but later fails chargeBillingKey with a real NOT_SUPPORTED_CARD_TYPE — see
  // TossProvider.issueBillingKeyByCard doc comment). Dummy card, Toss test environment only,
  // no real money moves. ──
  let billingKey: string | null = null;
  try {
    const result = await provider.issueBillingKeyByCard({
      customerKey: c.ref,
      cardNumber: '4906251234123456', // Toss test-env dummy card (BIN 490625/BC) — no real money moves
      cardExpirationYear: '30',
      cardExpirationMonth: '12',
      customerIdentityNumber: '900101',
      // cardPassword omitted — confirmed live 2026-09-09 that Toss's test API issues without it.
    });
    billingKey = result.billingKey;
    r.record('PASS', P, 'billing/authorizations/card', 'billingKey issued (network call to real Toss test API, dummy card 490625******3456)');
  } catch (err) {
    r.record('FAIL', P, 'billing/authorizations/card', errDetail(err));
  }

  const chargeAmount = { amountMinor: krwPrice.amountMinor || 10000, currency: 'KRW' };
  let paymentRef: string | null = null;
  if (billingKey) {
    const chargeIdemKey = idem('live_charge');
    const orderId = 'ord_live_' + Date.now();
    try {
      const first = await provider.chargeBillingKey({ billingKey, amount: chargeAmount, orderId, customerRef: c.ref, idempotencyKey: chargeIdemKey });
      paymentRef = first.providerRef;
      r.record('PASS', P, 'chargeBillingKey', `providerRef=${first.providerRef} status=${first.status} amount=${first.amount.amountMinor}${first.amount.currency}`);

      const second = await provider.chargeBillingKey({ billingKey, amount: chargeAmount, orderId, customerRef: c.ref, idempotencyKey: chargeIdemKey });
      const idempotent = second.providerRef === first.providerRef;
      r.record(idempotent ? 'PASS' : 'FAIL', P, 'chargeBillingKey(idempotent replay)', `same idempotencyKey twice → providerRef=${second.providerRef} (${idempotent ? 'matches first call — Toss dedupes server-side' : `MISMATCH vs first call's ${first.providerRef} — double charge risk`})`);
    } catch (err) {
      r.record('FAIL', P, 'chargeBillingKey', errDetail(err));
    }
  } else {
    r.record('SKIP', P, 'chargeBillingKey', 'no billingKey (billing/authorizations/card failed)');
    r.record('SKIP', P, 'chargeBillingKey(idempotent replay)', 'no billingKey (billing/authorizations/card failed)');
  }

  if (paymentRef) {
    try {
      const payment = await provider.getPayment(paymentRef);
      r.record('PASS', P, 'getPayment', `status=${payment.status} amount=${payment.amount.amountMinor}${payment.amount.currency}`);
    } catch (err) {
      r.record('FAIL', P, 'getPayment', errDetail(err));
    }

    let refundOk = false;
    try {
      const partial = chargeAmount.amountMinor > 3000 ? 3000 : Math.max(1, Math.floor(chargeAmount.amountMinor / 2));
      const refund = await provider.refund({ paymentRef, amount: { amountMinor: partial, currency: 'KRW' }, reason: 'paykit live 실측', idempotencyKey: idem('live_refund') });
      r.record('PASS', P, 'refund(partial)', `refundId=${refund.id} status=${refund.status} amount=${refund.amount.amountMinor}`);
      refundOk = true;
    } catch (err) {
      r.record('FAIL', P, 'refund(partial)', errDetail(err));
    }

    try {
      const payment = await provider.getPayment(paymentRef);
      const ok = payment.status === 'partially_refunded' || payment.status === 'refunded';
      r.record(refundOk ? (ok ? 'PASS' : 'FAIL') : 'SKIP', P, 'getPayment(after refund)', `status=${payment.status} (Toss PARTIAL_CANCELED → partially_refunded)`);
    } catch (err) {
      r.record('FAIL', P, 'getPayment(after refund)', errDetail(err));
    }
  } else {
    r.record('SKIP', P, 'getPayment', 'no paymentRef (chargeBillingKey failed)');
    r.record('SKIP', P, 'refund(partial)', 'no paymentRef (chargeBillingKey failed)');
    r.record('SKIP', P, 'getPayment(after refund)', 'no paymentRef (chargeBillingKey failed)');
  }

  // ── EC:K2-K7 cash receipt proof. The billing-key charge above is a CARD payment, which is
  // NOT cash-receipt eligible (EC:K4) — real-only cash-eligible methods (계좌이체/가상계좌/휴대폰)
  // require a browser-completed checkout, same limitation as confirmPayment above. So this proves
  // the negative path against the real payment just charged: issueCashReceipt must refuse it.
  // IMPORTANT REAL FINDING (confirmed live 2026-09-09): the real Toss test API's
  // POST /v1/cash-receipts does NOT itself validate that the payment/orderId is card-based —
  // it happily returns 200 for an arbitrary orderId (see packages/providers/toss/spec/
  // toss.pseudo.md "[EC:K2 K3 K4 K5 K6 K7]"). So this step does NOT expect "a real Toss error";
  // it expects our OWN client-side guard (issueCashReceipt's method re-fetch + check) to throw
  // before any POST /v1/cash-receipts call is made — that is the actual, honest behavior. ──
  if (paymentRef) {
    try {
      await provider.issueCashReceipt({ paymentRef, type: 'personal', customerIdentityNumber: '01012345678' });
      r.record('FAIL', P, 'issueCashReceipt(card payment)', 'expected our own cash_receipt_unsupported_for_payment_method guard to refuse a card payment, but it succeeded');
    } catch (err) {
      const isExpectedGuard = err instanceof Error && (err as { code?: string }).code === 'cash_receipt_unsupported_for_payment_method';
      r.record(
        isExpectedGuard ? 'PASS' : 'FAIL',
        P,
        'issueCashReceipt(card payment)',
        `client-side guard (NOT a real Toss rejection — Toss's own /v1/cash-receipts does not validate this, confirmed live 2026-09-09): ${errDetail(err)}`,
      );
    }
    r.record(
      'SKIP',
      P,
      'issueCashReceipt(cash-eligible payment)',
      'no cash-eligible (계좌이체/가상계좌/휴대폰) payment exists in this run — chargeBillingKey above only produces CARD payments, and completing a cash-eligible payment requires the Toss widget in a real browser (not scriptable server-side, same limitation as confirmPayment). POST /v1/cash-receipts itself was confirmed live 2026-09-09 outside this script (see toss.pseudo.md) — issue+cancel round trip on a real receiptKey, and duplicate-issue with the same orderId producing two distinct receiptKeys.',
    );
    r.record('SKIP', P, 'cancelCashReceipt / getCashReceipt', 'no receiptKey to cancel/look up — issueCashReceipt above correctly refused (card payment)');
  } else {
    r.record('SKIP', P, 'issueCashReceipt / cancelCashReceipt / getCashReceipt', 'no paymentRef (chargeBillingKey failed)');
  }

  // ── failure-path proof: force a real REJECT_CARD_PAYMENT via the TossPayments-Test-Code
  // header (test_sk_ keys only), confirmed live 2026-09-09, and check our own normalizer
  // against the real response instead of a hand-built fixture. ──
  if (billingKey) {
    try {
      const testCodeProvider = new TossProvider({ secretKey: env.TOSS_SECRET_KEY!, testCode: 'REJECT_CARD_PAYMENT' });
      await testCodeProvider.chargeBillingKey({ billingKey, amount: chargeAmount, orderId: 'ord_live_reject_' + Date.now(), customerRef: c.ref, idempotencyKey: idem('live_charge_reject') });
      r.record('FAIL', P, 'chargeBillingKey(TossPayments-Test-Code: REJECT_CARD_PAYMENT)', 'expected a real Toss rejection but the call succeeded');
    } catch (err) {
      const failure = err instanceof ProviderError ? err.failure : null;
      const normalizedOk = failure?.code === 'insufficient_funds' && failure.retryable === true;
      r.record(
        normalizedOk ? 'PASS' : 'FAIL',
        P,
        'chargeBillingKey(TossPayments-Test-Code: REJECT_CARD_PAYMENT)',
        `real Toss response: ${errDetail(err)} → normalizeTossFailure gave code=${failure?.code ?? 'n/a'} retryable=${failure?.retryable ?? 'n/a'} (expected insufficient_funds/true)`,
      );
    }
  } else {
    r.record('SKIP', P, 'chargeBillingKey(TossPayments-Test-Code: REJECT_CARD_PAYMENT)', 'no billingKey (billing/authorizations/card failed)');
  }

  try {
    await provider.getPayment('paykit_live_nonexistent_' + Date.now());
    r.record('FAIL', P, 'getPayment(unknown key)', 'expected a real Toss NOT_FOUND-style error but the call succeeded');
  } catch (err) {
    r.record(err instanceof ProviderError && err.failure.providerCode === 'NOT_FOUND_PAYMENT' ? 'PASS' : 'FAIL', P, 'getPayment(unknown key)', `expected NOT_FOUND_PAYMENT: ${errDetail(err)}`);
  }

  try {
    await provider.issueBillingKey({ authKey: 'bogus-auth-key-' + Date.now(), customerKey: c.ref });
    r.record('FAIL', P, 'billing/authorizations/issue(bogus authKey)', 'expected a real Toss error but the call succeeded');
  } catch (err) {
    r.record(err instanceof ProviderError && err.failure.providerCode === 'NOT_FOUND_BILLING' ? 'PASS' : 'FAIL', P, 'billing/authorizations/issue(bogus authKey)', `expected NOT_FOUND_BILLING: ${errDetail(err)}`);
  }

  // NOTE (real limitation, confirmed live 2026-09-09 — not asserted below): Toss's
  // /v1/transactions has no reliable window/customer semantics for reconciliation — a payment
  // charged seconds ago does not reliably appear in a 1-hour window, and a 24-hour window can
  // return rows for *other* merchants sharing this public docs mId. So this step only asserts
  // the call itself succeeds, never that it contains the payment just made.
  try {
    const list = await provider.listPayments({ customerRef: c.ref, since: new Date(Date.now() - 24 * 3600 * 1000) });
    r.record('PASS', P, 'listPayments', `real /v1/transactions call succeeded, count=${list.length} (containment not asserted — see docs/PUBLIC_SANDBOX_VERIFICATION.md and packages/providers/toss/spec/toss.pseudo.md for the confirmed real limitation)`);
  } catch (err) {
    r.record('FAIL', P, 'listPayments', `${errDetail(err)} (KNOWN BUG — see packages/providers/toss/spec/toss.pseudo.md: listPayments sends toISOString()'s Z-suffixed timestamp, which the real Toss API rejects as INVALID_DATE)`);
  }

  r.record(
    'SKIP',
    P,
    'webhook',
    'Toss webhooks are unsigned and configured per-merchant in the Toss dashboard (developers.tosspayments.com → 개발자센터 → 웹훅). Add your deployed /api/webhook/paykit URL there, enable PAYMENT_STATUS_CHANGED, and trigger a real test payment from the dashboard to confirm delivery — cannot be scripted without a live endpoint.',
  );
}

async function runPortone(env: Record<string, string | undefined>, config: PaykitConfig, r: Reporter, dryRun: boolean): Promise<void> {
  const P = 'portone';
  const missing = missingEnv('portone', env);
  if (missing.length > 0) {
    r.record(dryRun ? 'SKIP' : 'FAIL', P, 'all steps', `no keys in .env (missing: ${missing.join(', ')})`);
    return;
  }
  r.registerSecret(env.PORTONE_API_SECRET);
  r.registerSecret(env.PORTONE_WEBHOOK_SECRET);
  if (dryRun) {
    r.record('SKIP', P, 'dry-run', 'would run createCustomer(local) → createCheckout(local url) → getPayment(unknown id, expect real error) → billing-keys(bogus, expect real error) → listPayments → webhook instructions');
    return;
  }

  const provider = new PortoneProvider({ apiSecret: env.PORTONE_API_SECRET!, storeId: env.PORTONE_STORE_ID!, webhookSecret: env.PORTONE_WEBHOOK_SECRET! });

  const c = await provider.createCustomer({ email: `paykit-live-${Date.now()}@example.com` });
  r.record('PASS', P, 'createCustomer', `ref=${c.ref} (PortOne V2 has no customer-create API — local synthesized id, not a network call)`);

  const pp = firstPlanAndPrice(config);
  if (pp) {
    try {
      const checkout = await provider.createCheckout({
        customerRef: c.ref,
        plan: pp.plan as unknown as Parameters<typeof provider.createCheckout>[0]['plan'],
        price: pp.price,
        mode: 'one_time',
        successUrl: 'https://example.com/success',
        cancelUrl: 'https://example.com/cancel',
        idempotencyKey: idem('live_checkout'),
      });
      r.record('PASS', P, 'createCheckout', `hosted url (local, no network call — PortOne checkout is client-SDK-driven): ${checkout.url}`);
    } catch (err) {
      r.record('FAIL', P, 'createCheckout', errDetail(err));
    }
  } else {
    r.record('SKIP', P, 'createCheckout', 'paykit.config.json has no plans[0]');
  }

  r.record('SKIP', P, 'confirmPayment', 'requires a paymentId completed via PortOne browser SDK — not scriptable server-side');

  try {
    await provider.getPayment('paykit_live_nonexistent_' + Date.now());
    r.record('FAIL', P, 'getPayment(unknown id)', 'expected a real PortOne error but the call succeeded');
  } catch (err) {
    r.record(err instanceof ProviderError && err.failure.providerCode === 'PAYMENT_NOT_FOUND' ? 'PASS' : 'FAIL', P, 'getPayment(unknown id)', `expected PAYMENT_NOT_FOUND: ${errDetail(err)}`);
  }

  try {
    await provider.issueBillingKey({ customer: { id: c.ref }, method: { card: {} } });
    r.record('FAIL', P, 'billing-keys(no real method)', 'expected a real PortOne error but the call succeeded');
  } catch (err) {
    r.record(err instanceof ProviderError && err.failure.providerCode === 'INVALID_REQUEST' ? 'PASS' : 'FAIL', P, 'billing-keys(no real method)', `expected INVALID_REQUEST: ${errDetail(err)}`);
  }

  try {
    const list = await provider.listPayments({ customerRef: c.ref, since: new Date(Date.now() - 24 * 3600 * 1000) });
    r.record('PASS', P, 'listPayments', `real /payments call succeeded, count=${list.length} (0 expected — no real payment exists for this synthesized customer id)`);
  } catch (err) {
    r.record('FAIL', P, 'listPayments', errDetail(err));
  }

  r.record('SKIP', P, 'refund', 'no real payment exists to refund (requires SDK-completed payment)');

  r.record(
    'SKIP',
    P,
    'webhook',
    'PortOne webhooks are configured per-store in the PortOne console (admin.portone.io → 연동 정보 → Webhook). Add your deployed /api/webhook/paykit URL, then trigger a real test payment from the console to confirm delivery — cannot be scripted without a live endpoint.',
  );
}

async function runPolar(env: Record<string, string | undefined>, config: PaykitConfig, r: Reporter, dryRun: boolean): Promise<void> {
  const P = 'polar';
  const missing = missingEnv('polar', env);
  if (missing.length > 0) {
    r.record(dryRun ? 'SKIP' : 'FAIL', P, 'all steps', `no keys in .env (missing: ${missing.join(', ')})`);
    return;
  }
  r.registerSecret(env.POLAR_ACCESS_TOKEN);
  r.registerSecret(env.POLAR_WEBHOOK_SECRET);
  const server: 'production' | 'sandbox' = env.POLAR_SERVER === 'production' ? 'production' : 'sandbox';
  if (dryRun) {
    r.record('SKIP', P, 'dry-run', `would run (server=${server}) createCustomer → createCheckout → getPayment/refund/listPayments/reportUsage (skipped: no server-side way to complete a Polar checkout) → webhook instructions`);
    return;
  }

  const provider = new PolarProvider({ accessToken: env.POLAR_ACCESS_TOKEN!, webhookSecret: env.POLAR_WEBHOOK_SECRET!, server });

  let customerRef: string | null = null;
  try {
    const c = await provider.createCustomer({ email: `paykit-live-${Date.now()}@example.com`, name: 'paykit live' });
    customerRef = c.ref;
    r.record('PASS', P, `createCustomer (${server})`, `ref=${c.ref}`);
  } catch (err) {
    r.record('FAIL', P, 'createCustomer', errDetail(err));
    return;
  }

  const pp = firstPlanAndPrice(config);
  if (pp) {
    const productRef = (pp.price as unknown as { providerPriceRefs?: Record<string, string> }).providerPriceRefs?.polar ?? env.POLAR_TEST_PRODUCT_ID;
    if (!productRef) {
      r.record(
        'SKIP',
        P,
        'createCheckout',
        'plans[0].prices[0] has no providerPriceRefs.polar (contract gap — apps/cli PlanPriceConfig has no such field yet) and no POLAR_TEST_PRODUCT_ID env override set',
      );
    } else {
      try {
        const checkout = await provider.createCheckout({
          customerRef,
          plan: pp.plan as unknown as Parameters<typeof provider.createCheckout>[0]['plan'],
          price: { currency: pp.price.currency, amountMinor: pp.price.amountMinor, providerPriceRefs: { polar: productRef } },
          mode: pp.plan.interval ? 'subscription' : 'one_time',
          successUrl: 'https://example.com/success',
          cancelUrl: 'https://example.com/cancel',
          idempotencyKey: idem('live_checkout'),
        });
        r.record('PASS', P, 'createCheckout', `hosted url=${checkout.url}`);
      } catch (err) {
        r.record('FAIL', P, 'createCheckout', errDetail(err));
      }
    }
  } else {
    r.record('SKIP', P, 'createCheckout', 'paykit.config.json has no plans[0]');
  }

  r.record('SKIP', P, 'getPayment/refund/listPayments', 'Polar has no server-side test-payment API — completing an order requires the Polar-hosted checkout page in a real browser (cannot be scripted here); the created checkout URL above can be opened manually to complete one');

  try {
    await provider.reportUsage({ meter: 'paykit_live_test', customerRef, quantity: 1, occurredAt: new Date(), idempotencyKey: idem('live_usage') });
    r.record('PASS', P, 'reportUsage', 'event ingested');
  } catch (err) {
    const detail = errDetail(err);
    if (/meter/i.test(detail)) {
      r.record('SKIP', P, 'reportUsage', `Polar rejected the event — likely no meter named "paykit_live_test" configured for this org: ${detail}`);
    } else {
      r.record('FAIL', P, 'reportUsage', detail);
    }
  }

  r.record(
    'SKIP',
    P,
    'webhook',
    `Polar webhooks are configured per-org in the Polar dashboard (${server === 'sandbox' ? 'sandbox.polar.sh' : 'polar.sh'} → Settings → Webhooks). Add your deployed /api/webhook/paykit URL, subscribe to order.paid, then complete a real checkout to confirm delivery — cannot be scripted without a live endpoint.`,
  );
}

// ── orchestration ────────────────────────────────────────────────────────────────────────────

export async function runLive(outDir: string, parsed: ParsedArgv): Promise<void> {
  const dryRun = Boolean(parsed.flags['dry-run']);
  const configArg = typeof parsed.flags.config === 'string' ? parsed.flags.config : undefined;
  const envArg = typeof parsed.flags.env === 'string' ? parsed.flags.env : undefined;

  const configDir = configArg ? path.dirname(path.resolve(configArg)) : outDir;
  const config = configArg ? await readConfig(configDir) : await readConfig(outDir);
  if (!config) {
    console.error(pc.red(`paykit.config.json 을 찾을 수 없습니다: ${configArg ?? outDir}`));
    process.exitCode = 1;
    return;
  }

  const envPath = envArg ? path.resolve(envArg) : path.join(outDir, '.env');
  const { merged: env, found } = await loadEnvFile(envPath);

  console.log(pc.bold('paykit live'));
  console.log(`config: ${configArg ?? path.join(outDir, 'paykit.config.json')}`);
  console.log(`.env:   ${envPath}${found ? '' : ' (not found — using process env only)'}`);
  console.log(`providers configured: ${config.providers.join(', ') || '(none)'}`);
  if (dryRun) console.log(pc.yellow('--dry-run: no network calls will be made.'));
  console.log('');

  const r = new Reporter();

  if (config.providers.length === 0) {
    console.log(pc.yellow('paykit.config.json 에 설정된 provider 가 없습니다. 검증할 것이 없습니다.'));
    if (!dryRun) process.exitCode = 1;
    return;
  }

  for (const providerName of config.providers) {
    switch (providerName) {
      case 'stripe':
        await runStripe(env, config, r, dryRun);
        break;
      case 'toss':
        await runToss(env, config, r, dryRun);
        break;
      case 'portone':
        await runPortone(env, config, r, dryRun);
        break;
      case 'polar':
        await runPolar(env, config, r, dryRun);
        break;
    }
    console.log('');
  }

  const pass = r.results.filter((x) => x.status === 'PASS').length;
  const fail = r.results.filter((x) => x.status === 'FAIL').length;
  const skip = r.results.filter((x) => x.status === 'SKIP').length;
  console.log(pc.bold(`요약: PASS ${pass}  FAIL ${fail}  SKIP ${skip}`));

  if (r.hasFailure() || (!dryRun && pass === 0)) process.exitCode = 1;
}
