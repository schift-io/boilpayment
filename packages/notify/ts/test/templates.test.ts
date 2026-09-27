// templates.render() coverage for every NotifyType (the full union from boilpayment-core), both
// locales. The rule checked is the contract, not the wording: a payload carrying the fields its
// senders send leaves no `{placeholder}` in the subject or text (EC:I11). Real sender payloads are
// rendered in packages/sdk/ts/test/round7-notify.test.ts.
import { describe, expect, it } from 'vitest';
import type { NotifyType } from 'boilpayment-core';
import { render, templates } from '../src/index.js';

// The exhaustive NotifyType union, per packages/core/ts/src/types.ts.
const NOTIFY_TYPES: NotifyType[] = [
  'payment.failed',
  'grace.started',
  'grace.ending',
  'subscription.canceled',
  'refund.executed',
  'cs.needs_human',
  'reconcile.mismatch',
  'card.expiring',
  'usage.soft_cap',
  'credits.expiring',
];

interface Fixture {
  type: NotifyType;
  payload: Record<string, unknown>;
}

const FIXTURES: Fixture[] = [
  {
    type: 'payment.failed',
    payload: { subscriptionId: 'sub_1', graceUntil: '2026-09-16T00:00:00.000Z' },
  },
  {
    type: 'grace.started',
    payload: { subscriptionId: 'sub_1', graceUntil: '2026-09-16T00:00:00.000Z', graceDays: 7 },
  },
  {
    type: 'grace.ending',
    payload: { graceUntil: '2026-09-16' },
  },
  {
    type: 'subscription.canceled',
    payload: { detail: 'canceled at period end' },
  },
  {
    type: 'refund.executed',
    payload: { amount: '$25.00' },
  },
  {
    type: 'cs.needs_human',
    payload: { caseId: 'case_1', kind: 'refund', customerId: 'cust_1' },
  },
  {
    type: 'reconcile.mismatch',
    payload: { customerId: 'cust_1', detail: '2 payments, 1 grant' },
  },
  {
    type: 'card.expiring',
    payload: { expiresAt: '2026-10-01' },
  },
  {
    type: 'usage.soft_cap',
    payload: { meter: 'api_call', overage: 2, included: 5 },
  },
  {
    // EC:B16 — credits, not the card on file
    type: 'credits.expiring',
    payload: { amount: 120, expiresAt: '2026-03-01' },
  },
];

describe('notify: templates exhaustive coverage', () => {
  it('templates record has exactly the 10 NotifyTypes, each with en+ko template functions', () => {
    expect(Object.keys(templates).sort()).toEqual([...NOTIFY_TYPES].sort());
    expect(FIXTURES.map((f) => f.type).sort()).toEqual([...NOTIFY_TYPES].sort());
    for (const t of NOTIFY_TYPES) {
      expect(typeof templates[t].en).toBe('function');
      expect(typeof templates[t].ko).toBe('function');
    }
  });

  for (const fx of FIXTURES) {
    for (const locale of ['en', 'ko'] as const) {
      it(`notify: ${fx.type} ${locale} fills every placeholder`, () => {
        const out = render(fx.type, locale, fx.payload);
        expect(out.subject.length).toBeGreaterThan(0);
        expect(out.text.length).toBeGreaterThan(0);
        expect(`${out.subject} ${out.text}`).not.toMatch(/\{\w+\}/);
      });
    }
  }

  it('EC:I11 a field a template does not name still reaches a person through {detail}', () => {
    const out = render('cs.needs_human', 'en', { customerId: 'c1', kind: 'renewal_double_charge', paymentId: 'pay_2' });
    expect(out.text).toContain('paymentId=pay_2');
    expect(out.text).not.toMatch(/\{\w+\}/);
  });
});
