/**
 * Real code path smoke test for InMemoryLedger + period math.
 * Mirrors packages/core/py/examples/smoke.py exactly — same operations, same printed numbers.
 * Run: node_modules/.bin/tsx packages/core/ts/examples/smoke.ts
 */
import { InMemoryLedger } from '../src/memory.js';
import { FixedClock, SequentialIdGen } from '../src/clock.js';
import { nextPeriod, prorationRatio } from '../src/period.js';
import { ConsumeInput } from '../src/types.js';

function log(label: string, value: unknown): void {
  console.log(`${label} ${JSON.stringify(value)}`);
}

async function main(): Promise<void> {
  const clock = new FixedClock(new Date('2026-01-01T00:00:00.000Z'));
  const ledger = new InMemoryLedger(new SequentialIdGen('led_'));
  const customerId = 'cust_1';

  // grant 100 paid, expiring 30d from now
  const expiresAt = new Date(clock.now().getTime() + 30 * 86_400_000);
  await ledger.append({
    customerId,
    pool: 'paid',
    kind: 'grant',
    amount: 100,
    unitPriceMinor: 1000,
    currency: 'USD',
    expiresAt,
    source: 'subscription',
    reference: { subscriptionId: 'sub_1', periodStart: clock.now() },
    idempotencyKey: 'grant:sub_1:2026-01-01',
    actor: 'system',
    reason: null,
  });

  // grant 50 promo, no expiry
  await ledger.append({
    customerId,
    pool: 'promo',
    kind: 'grant',
    amount: 50,
    unitPriceMinor: null,
    currency: null,
    expiresAt: null,
    source: 'promo',
    reference: {},
    idempotencyKey: 'grant:promo:welcome',
    actor: 'system',
    reason: 'welcome bonus',
  });

  const balBeforeConsume = await ledger.balance(customerId, undefined, clock.now());
  log('balance_after_grants', { available: balBeforeConsume.available, held: balBeforeConsume.held });

  // consume 120 with poolOrder [promo, paid] -> drains promo (50) then paid (70 of 100)
  const consumeInput: ConsumeInput = {
    customerId,
    poolOrder: ['promo', 'paid'],
    amount: 120,
    idempotencyKey: 'consume:req-1',
    meta: { reason: 'test usage', actor: 'test' },
    now: clock.now(),
    negativeBalance: 'block',
    negativeFloor: 0,
  };
  const res1 = await ledger.consume(consumeInput);
  log('consume_120', {
    ok: res1.ok,
    shortfall: res1.shortfall,
    duplicated: res1.duplicated,
    entries: res1.entries.map((e) => ({ pool: e.pool, amount: e.amount, grantId: e.reference.grantId ?? null })),
  });

  const balAfterConsume = await ledger.balance(customerId, undefined, clock.now());
  log('balance_after_consume', {
    available: balAfterConsume.available,
    held: balAfterConsume.held,
    expiring: balAfterConsume.expiring.map((b) => ({ expiresAt: b.expiresAt.toISOString(), amount: b.amount })),
  });

  // consume overshoot under negativeBalance='block' -> ok=false, no entries written
  const overshootInput: ConsumeInput = {
    customerId,
    poolOrder: ['promo', 'paid'],
    amount: 1000,
    idempotencyKey: 'consume:req-2',
    meta: { reason: 'overshoot', actor: 'test' },
    now: clock.now(),
    negativeBalance: 'block',
    negativeFloor: 0,
  };
  const res2 = await ledger.consume(overshootInput);
  log('consume_overshoot_block', { ok: res2.ok, shortfall: res2.shortfall, entryCount: res2.entries.length });

  // duplicate idempotency key -> duplicated=true, same result as res1
  const res1dup = await ledger.consume(consumeInput);
  log('consume_120_duplicate', {
    duplicated: res1dup.duplicated,
    ok: res1dup.ok,
    sameEntryCount: res1dup.entries.length === res1.entries.length,
  });

  // EC:G1 next_period: 2026-01-31 monthly anchor 31 -> 2026-02-28 -> 2026-03-31
  const p0 = { start: new Date('2026-01-01T00:00:00.000Z'), end: new Date('2026-01-31T00:00:00.000Z') };
  const p1 = nextPeriod(p0, 'month', 31, 'UTC', 'clamp_keep_original_day');
  const p2 = nextPeriod(p1, 'month', 31, 'UTC', 'clamp_keep_original_day');
  log('next_period_step1', { start: p1.start.toISOString(), end: p1.end.toISOString() });
  log('next_period_step2', { start: p2.start.toISOString(), end: p2.end.toISOString() });

  // EC:G2 proration_ratio mid-period (15 of 30 days elapsed -> 0.5 remaining)
  const period = { start: new Date('2026-03-01T00:00:00.000Z'), end: new Date('2026-03-31T00:00:00.000Z') };
  const mid = new Date('2026-03-16T00:00:00.000Z');
  const ratio = prorationRatio(period, mid, 'actual_days_in_period');
  log('proration_ratio_mid_period', { ratio });
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
