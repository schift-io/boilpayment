// EC:H5 — GDPR/개인정보보호법 data export. Mirrors packages/cs/py/tests/test_export_customer.py.
// See docs/EDGE_CASES.md H5, packages/cs/spec/cs.pseudo.md [EC:H5].
import { describe, expect, it, beforeEach } from 'vitest';
import { FixedClock, InMemoryLedger, InMemoryRepo, SequentialIdGen, resolvePolicy } from '@schift/payment-kit-core';
import type { Customer, Payment } from '@schift/payment-kit-core';
import { openCase } from '../src/index.js';
import { exportCustomer } from '../src/exportCustomer.js';

let clock: FixedClock;
let ids: SequentialIdGen;
let repo: InMemoryRepo;
let ledger: InMemoryLedger;
const customerId = 'cust_exp';

beforeEach(() => {
  clock = new FixedClock(new Date('2026-01-01T00:00:00Z'));
  ids = new SequentialIdGen('id_');
  repo = new InMemoryRepo();
  ledger = new InMemoryLedger(ids);
});

async function seed() {
  const customer: Customer = {
    id: customerId, email: `${customerId}@x.com`,
    providerRefs: [{ provider: 'stripe', ref: 'cus_exp' }], status: 'active', createdAt: clock.now(),
  };
  await repo.customers.put(customer);

  const payment: Payment = {
    id: 'pay_exp', customerId, provider: 'stripe', providerRef: 'pi_exp', subscriptionId: null,
    amount: { amountMinor: 5000, currency: 'USD' }, status: 'succeeded', kind: 'topup', period: null,
    occurredAt: clock.now(), failure: null, cashReceipt: null,
    raw: { customerIdentityNumber: '901231-1234567', cardNumber: '4242424242424242' },
  };
  await repo.payments.put(payment);

  await ledger.append({
    customerId, pool: 'paid', kind: 'grant', amount: 100, unitPriceMinor: 50, currency: 'USD', expiresAt: null,
    source: 'topup', reference: { paymentId: payment.id }, idempotencyKey: `topup:${payment.id}`, actor: 'system', reason: null,
  });

  await repo.refunds.put({
    id: 'ref_exp', paymentId: payment.id, customerId, amount: { amountMinor: 1000, currency: 'USD' },
    status: 'succeeded', providerRef: 're_exp', creditsRevoked: 20, ruleId: 'D1', reason: 'no questions asked',
    failure: null, createdAt: clock.now(),
  });

  const policy = resolvePolicy({});
  await openCase({ customerId, kind: 'refund', referenceId: payment.id, policy, repo, clock, ids });

  return { customer, payment };
}

describe('cs.exportCustomer', () => {
  it('[EC:H5] contains every section, has schemaVersion/generatedAt, and is JSON round-trippable', async () => {
    await seed();
    const result = await exportCustomer({ customerId, repo, ledger, clock });

    expect(result.schemaVersion).toBe(1);
    expect(typeof result.generatedAt).toBe('string');
    expect(result.customerId).toBe(customerId);
    expect(result.customer).toBeTruthy();
    expect(result.payments).toHaveLength(1);
    expect(result.ledgerEntries).toHaveLength(1);
    expect(result.refunds).toHaveLength(1);
    expect(result.csCases).toHaveLength(1);
    expect(result.usageEvents).toEqual([]);
    expect(result.subscriptions).toEqual([]);
    expect(result.timeline.events.length).toBeGreaterThan(0);

    const roundTripped = JSON.parse(JSON.stringify(result));
    expect(roundTripped).toEqual(result);
  });

  it('[EC:H5] redacts PII by default', async () => {
    await seed();
    const result = await exportCustomer({ customerId, repo, ledger, clock });
    expect(result.redacted).toBe(true);
    const payment = result.payments[0] as { raw: { customerIdentityNumber: string; cardNumber: string } };
    expect(payment.raw.customerIdentityNumber).toBe('[redacted]'); // key-name redacted
    expect(payment.raw.cardNumber).toBe('[redacted]'); // key-name redacted (not just PAN-masked)
  });

  it('[EC:H5] does not redact when redact:false — only for a legally-answered SAR', async () => {
    await seed();
    const result = await exportCustomer({ customerId, repo, ledger, clock, redact: false });
    expect(result.redacted).toBe(false);
    const payment = result.payments[0] as { raw: { customerIdentityNumber: string; cardNumber: string } };
    expect(payment.raw.customerIdentityNumber).toBe('901231-1234567');
    expect(payment.raw.cardNumber).toBe('4242424242424242');
  });
});
