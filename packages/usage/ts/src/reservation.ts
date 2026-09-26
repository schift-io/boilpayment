// EC:C10 — usage reservations for long-running work. See spec/usage.pseudo.md.
//
// reserve() holds credits for a job before the work starts; commit() charges what the job actually
// used (<= the reservation) when it succeeds; release() drops the hold when it fails or is cancelled.
// A reservation is a pair of ledger rows keyed by the job: a `hold` (negative) written by reserve()
// and a `release` (positive, same size) written by commit/release/sweep. Holds already count
// against `balance().available` in every store, so two reserves racing for the last credits are
// serialized by the per-customer ledger transaction and exactly one wins.
import { PaymentKitError } from 'boilpayment-core';
import type { Clock, ConsumeOrder, LedgerEntry, LedgerStore, Policy, Pool, Repo, Subscription } from 'boilpayment-core';
import { hasNoEntitlement } from './check.js';

const POOL_ORDER: Record<ConsumeOrder, Pool[]> = {
  expiring_first: ['paid', 'promo', 'trial'],
  promo_first_then_expiring: ['promo', 'trial', 'paid'],
  paid_first: ['paid', 'trial', 'promo'],
};
const REASON_PREFIX = 'reservation:';

export type ReservationStatus = 'held' | 'committed' | 'released' | 'expired';

export interface Reservation {
  customerId: string;
  jobId: string;
  amount: number;
  status: ReservationStatus;
  expiresAt: Date;
  /** Credits charged by commit(); null unless status === 'committed'. */
  committedAmount: number | null;
}

interface ReservationDeps {
  customerId: string;
  jobId: string;
  policy: Policy;
  ledger: LedgerStore;
  clock: Clock;
}

export interface ReserveInput extends ReservationDeps {
  amount: number;
  /** EC:C11 — when given, a subscription without entitlement (paused, incomplete, canceled, expired) is refused. */
  sub?: Pick<Subscription, 'status'>;
}
export type ReserveResult =
  | { ok: true; reservation: Reservation; duplicated: boolean }
  | { ok: false; reason: 'insufficient'; need: number; available: number }
  | { ok: false; reason: 'subscription_inactive' };

export interface CommitInput extends ReservationDeps {
  /** What the job actually used, 0 <= amount <= reserved. */
  amount: number;
}
export interface SettleResult {
  reservation: Reservation;
  duplicated: boolean;
}

const holdKey = (c: string, j: string) => `usage:reserve:${c}:${j}`;
const releaseKey = (c: string, j: string) => `usage:reserve:release:${c}:${j}`;
const commitKey = (c: string, j: string) => `usage:reserve:commit:${c}:${j}`;

function statusFrom(release: LedgerEntry | undefined): { status: ReservationStatus; committed: number | null } {
  if (!release) return { status: 'held', committed: null };
  const tail = (release.reason ?? '').slice(REASON_PREFIX.length);
  if (tail.startsWith('committed:')) return { status: 'committed', committed: Number(tail.slice('committed:'.length)) };
  return { status: tail === 'expired' ? 'expired' : 'released', committed: null };
}

async function readAll(ledger: LedgerStore, customerId: string): Promise<Reservation[]> {
  const holds = (await ledger.entries(customerId, { kind: 'hold', source: 'usage' })).filter((e) => e.idempotencyKey.startsWith('usage:reserve:'));
  if (!holds.length) return [];
  const releases = new Map(
    (await ledger.entries(customerId, { kind: 'release', source: 'usage' })).map((e) => [e.idempotencyKey, e] as const),
  );
  return holds.map((h) => {
    const jobId = (h.reason ?? '').slice(REASON_PREFIX.length);
    const { status, committed } = statusFrom(releases.get(releaseKey(customerId, jobId)));
    return { customerId, jobId, amount: -h.amount, status, expiresAt: h.expiresAt!, committedAmount: committed };
  });
}

async function readOne(ledger: LedgerStore, customerId: string, jobId: string): Promise<Reservation | null> {
  return (await readAll(ledger, customerId)).find((r) => r.jobId === jobId) ?? null;
}

async function close(ledger: LedgerStore, r: Reservation, how: 'released' | 'expired' | `committed:${number}`): Promise<void> {
  await ledger.append({
    customerId: r.customerId, pool: 'paid', kind: 'release', amount: r.amount, unitPriceMinor: null, currency: null,
    expiresAt: null, source: 'usage', reference: {}, idempotencyKey: releaseKey(r.customerId, r.jobId),
    actor: 'usage', reason: `${REASON_PREFIX}${how}`,
  });
}

async function expireDue(ledger: LedgerStore, customerId: string, now: Date): Promise<number> {
  let n = 0;
  for (const r of await readAll(ledger, customerId)) {
    if (r.status === 'held' && r.expiresAt.getTime() <= now.getTime()) {
      await close(ledger, r, 'expired');
      n++;
    }
  }
  return n;
}

function checkJob(customerId: string, jobId: string): void {
  if (!customerId || !jobId) throw new PaymentKitError('reservation needs customerId and jobId', 'reservation_invalid');
}

/** EC:C10 — hold `amount` credits for `jobId`. Same jobId again returns the existing reservation. */
export async function reserve(input: ReserveInput): Promise<ReserveResult> {
  const { customerId, jobId, amount, policy, ledger, clock } = input;
  checkJob(customerId, jobId);
  if (!Number.isSafeInteger(amount) || amount <= 0) throw new PaymentKitError('reservation amount must be a positive integer', 'reservation_invalid');
  if (input.sub && hasNoEntitlement(input.sub.status)) return { ok: false, reason: 'subscription_inactive' }; // EC:C11
  return ledger.transaction(customerId, async () => {
    const now = clock.now();
    const existing = await readOne(ledger, customerId, jobId);
    if (existing) return { ok: true, reservation: existing, duplicated: true };
    await expireDue(ledger, customerId, now); // stale holds of this customer stop blocking new work
    const available = (await ledger.balance(customerId, undefined, now)).available;
    if (available < amount) return { ok: false, reason: 'insufficient', need: amount, available: Math.max(0, available) };
    const expiresAt = new Date(now.getTime() + policy.usage.reservationTtlMinutes * 60_000);
    await ledger.append({
      customerId, pool: 'paid', kind: 'hold', amount: -amount, unitPriceMinor: null, currency: null, expiresAt,
      source: 'usage', reference: {}, idempotencyKey: holdKey(customerId, jobId), actor: 'usage', reason: `${REASON_PREFIX}${jobId}`,
    });
    return { ok: true, reservation: { customerId, jobId, amount, status: 'held', expiresAt, committedAmount: null }, duplicated: false };
  });
}

/** EC:C10 — the job succeeded: charge `amount` (<= reserved) and release the hold. */
export async function commit(input: CommitInput): Promise<SettleResult> {
  const { customerId, jobId, amount, policy, ledger, clock } = input;
  checkJob(customerId, jobId);
  if (!Number.isSafeInteger(amount) || amount < 0) throw new PaymentKitError('commit amount must be a non-negative integer', 'reservation_invalid');
  return ledger.transaction(customerId, async () => {
    const now = clock.now();
    const r = await readOne(ledger, customerId, jobId);
    if (!r) throw new PaymentKitError(`no reservation for job ${jobId}`, 'reservation_not_found');
    if (r.status === 'committed') return { reservation: r, duplicated: true };
    if (r.status !== 'held') throw new PaymentKitError(`reservation for job ${jobId} is ${r.status}`, 'reservation_closed');
    if (r.expiresAt.getTime() <= now.getTime()) {
      await close(ledger, r, 'expired');
      throw new PaymentKitError(`reservation for job ${jobId} expired at ${r.expiresAt.toISOString()}`, 'reservation_expired');
    }
    if (amount > r.amount) throw new PaymentKitError(`commit ${amount} exceeds reservation ${r.amount}`, 'reservation_exceeded');
    if (amount > 0) {
      // Charge before releasing: if the charge fails the hold stays and the caller can release().
      const charged = await ledger.consume({
        customerId, poolOrder: POOL_ORDER[policy.credits.consumeOrder], amount, idempotencyKey: commitKey(customerId, jobId),
        meta: { reason: `usage:reservation:${jobId}` }, now,
        negativeBalance: policy.credits.negativeBalance, negativeFloor: policy.credits.negativeFloor,
      });
      if (!charged.ok) throw new PaymentKitError(`commit for job ${jobId} short by ${charged.shortfall}`, 'reservation_commit_short', { shortfall: charged.shortfall });
    }
    await close(ledger, r, `committed:${amount}`);
    return { reservation: { ...r, status: 'committed', committedAmount: amount }, duplicated: false };
  });
}

/** EC:C10 — the job failed or was cancelled: drop the hold, charge nothing. */
export async function release(input: ReservationDeps): Promise<SettleResult> {
  const { customerId, jobId, ledger } = input;
  checkJob(customerId, jobId);
  return ledger.transaction(customerId, async () => {
    const r = await readOne(ledger, customerId, jobId);
    if (!r) throw new PaymentKitError(`no reservation for job ${jobId}`, 'reservation_not_found');
    if (r.status !== 'held') return { reservation: r, duplicated: true };
    await close(ledger, r, 'released');
    return { reservation: { ...r, status: 'released' }, duplicated: false };
  });
}

/** EC:C10 — cron: release every reservation past its TTL. Returns how many were released. */
export async function sweepReservations(input: { repo: Repo; ledger: LedgerStore; clock: Clock }): Promise<{ expired: number }> {
  const now = input.clock.now();
  let expired = 0;
  for (const c of await input.repo.customers.list()) {
    expired += await input.ledger.transaction(c.id, () => expireDue(input.ledger, c.id, now));
  }
  return { expired };
}

/** Current reservations of a customer (any status), for dashboards and support. */
export async function listReservations(input: { customerId: string; ledger: LedgerStore }): Promise<Reservation[]> {
  return readAll(input.ledger, input.customerId);
}
