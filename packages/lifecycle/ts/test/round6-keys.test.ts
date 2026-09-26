// Round-6 audit A6-2 / A6-8 (bp-audit6.md): canonical UTC keys (EC:J11) and one DST rule (EC:J12).
import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { FixedClock, InMemoryLedger, InMemoryRepo, SequentialIdGen, resolvePolicy } from 'boilpayment-core';
import type { Payment, Period, Plan, Subscription } from 'boilpayment-core';
import { onRenewalPaid } from '../src/index.js';
import { catchUpPeriods } from '../src/missed-periods.js';

const plan: Plan = { id: 'p', name: 'P', interval: 'month', creditsPerPeriod: 100, usageIncluded: 0, trialDays: 0,
  prices: [{ currency: 'KRW', amountMinor: 5000, providerPriceRefs: {} }] };
const JAN: Period = { start: new Date('2024-01-01T00:00:00Z'), end: new Date('2024-02-01T00:00:00Z') };
const FEB: Period = { start: new Date('2024-02-01T00:00:00Z'), end: new Date('2024-03-01T00:00:00Z') };
const sub: Subscription = { id: 's1', customerId: 'c1', planId: 'p', provider: 'toss', providerRef: null, status: 'active', currentPeriod: JAN,
  anchorDay: 1, cancelAtPeriodEnd: false, graceUntil: null, billingKey: 'bk', scheduledPlanId: null, version: 0, currency: 'KRW', createdAt: JAN.start } as Subscription;
const pay = (id: string): Payment => ({ id, customerId: 'c1', provider: 'toss', providerRef: `pk_${id}`, subscriptionId: 's1',
  amount: { amountMinor: 5000, currency: 'KRW' }, status: 'succeeded', kind: 'subscription', period: FEB, occurredAt: FEB.start, failure: null });

describe('EC:J11 grant keys written by the Python kit before the fix are the same grant', () => {
  for (const legacy of ['grant:s1:2024-02-01T09:00:00+09:00', 'grant:s1:2024-02-01T00:00:00+00:00']) {
    it(`${legacy} → no second grant`, async () => {
      const repo = new InMemoryRepo(); await repo.plans.put(plan); await repo.subscriptions.put(sub);
      const ledger = new InMemoryLedger(new SequentialIdGen('l_'));
      await ledger.append({ customerId: 'c1', pool: 'paid', kind: 'grant', amount: 100, unitPriceMinor: 50, currency: 'KRW', expiresAt: FEB.end,
        source: 'subscription', reference: { subscriptionId: 's1' }, idempotencyKey: legacy, actor: 'system', reason: null });
      const r = await onRenewalPaid({ sub: (await repo.subscriptions.get('s1'))!, payment: pay('b'), policy: resolvePolicy(), ledger, repo, clock: new FixedClock(FEB.start) });
      expect(r.duplicated).toBe(true);
      expect((await ledger.entries('c1', { kind: 'grant', source: 'subscription' })).length).toBe(1);
    });
  }
});

describe('EC:J12 the missed-period anchor math gives the same answer in TS and Python (DST zones included)', () => {
  it('6,000 generated cases, 0 mismatches', () => {
    let seed = 42; const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
    const pick = <T>(a: T[]) => a[Math.floor(rnd() * a.length)];
    const tzs = ['UTC', 'Asia/Seoul', 'America/New_York', 'Pacific/Auckland', 'Australia/Lord_Howe', 'America/St_Johns', 'Europe/London'];
    const cases: any[] = [];
    for (let i = 0; i < 6000; i++) {
      const tz = pick(tzs); const interval = rnd() < 0.8 ? 'month' : 'year'; const anchorDay = pick([1, 15, 28, 29, 30, 31]);
      const mea = pick(['clamp_keep_original_day', 'clamp_permanently']);
      const y = pick([2023, 2024, 2025, 2027, 2028]); const m = 1 + Math.floor(rnd() * 12);
      const dim = new Date(Date.UTC(y, m, 0)).getUTCDate(); const day = Math.min(anchorDay, dim);
      const hour = pick([0, 0, 0, 1, 2, 3, 15, 23]);
      cases.push({ tz, interval, anchorDay, mea, startIso: new Date(Date.UTC(y, m - 1, day, hour)).toISOString(),
        nowOffsetDays: Math.floor(rnd() * (interval === 'year' ? 1500 : 1300)), nowExtraMs: Math.floor(rnd() * 86_400_000) });
    }
    const ts = cases.map((c) => {
      const policy = resolvePolicy({ period: { timezone: c.tz, monthEndAnchor: c.mea } } as never);
      const s0 = new Date(c.startIso);
      const first = catchUpFirst(s0, c);
      const now = new Date(s0.getTime() + c.nowOffsetDays * 86_400_000 + c.nowExtraMs);
      const cu = catchUpPeriods({ currentPeriod: { start: s0, end: first }, anchorDay: c.anchorDay } as never, { interval: c.interval } as never, policy, now);
      return cu ? { p: cu.previous.start.toISOString(), t: [cu.target.start.toISOString(), cu.target.end.toISOString()], s: cu.skipped.map((x) => x.start.toISOString()) } : null;
    });
    const dir = mkdtempSync(join(tmpdir(), 'bp-dst-')); const file = join(dir, 'cases.json');
    writeFileSync(file, JSON.stringify(cases));
    const py = resolve(__dirname, '../../../../.venv/bin/python');
    const out = execFileSync(py, ['-c', PY, file], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
    const pyRes = JSON.parse(out);
    const mismatches = ts.filter((x, i) => JSON.stringify(x) !== JSON.stringify(pyRes[i])).length;
    expect(ts.filter(Boolean).length).toBeGreaterThan(5000);
    expect(mismatches).toBe(0);
  }, 120_000);
});

import { nextPeriod } from 'boilpayment-core';
function catchUpFirst(s0: Date, c: any): Date {
  return nextPeriod({ start: s0, end: s0 }, c.interval, c.anchorDay, c.tz, c.mea).end;
}

const PY = `
import json, sys
from datetime import datetime, timedelta, timezone
from types import SimpleNamespace
from boilpayment_core import Period, resolve_policy, next_period
from boilpayment_lifecycle.missed_periods import catch_up_periods
def z(dt): return dt.astimezone(timezone.utc).strftime('%Y-%m-%dT%H:%M:%S.') + f"{dt.astimezone(timezone.utc).microsecond // 1000:03d}Z"
out = []
for c in json.load(open(sys.argv[1])):
    policy = resolve_policy({'period': {'timezone': c['tz'], 'month_end_anchor': c['mea']}})
    s0 = datetime.fromisoformat(c['startIso'].replace('Z', '+00:00'))
    first = next_period(Period(start=s0, end=s0), c['interval'], c['anchorDay'], c['tz'], c['mea'])
    cu = catch_up_periods(SimpleNamespace(current_period=Period(start=s0, end=first.end), anchor_day=c['anchorDay']),
                          SimpleNamespace(interval=c['interval']), policy, s0 + timedelta(days=c['nowOffsetDays'], milliseconds=c['nowExtraMs']))
    out.append(None if cu is None else {'p': z(cu.previous.start), 't': [z(cu.target.start), z(cu.target.end)], 's': [z(x.start) for x in cu.skipped]})
print(json.dumps(out))
`;
