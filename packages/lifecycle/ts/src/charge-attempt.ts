// spec: packages/lifecycle/spec/lifecycle.pseudo.md — EC:A26 A34 A35 A36
// EC:A26 — Toss sends no webhook for billing payments, so the renewal's payment row is stored here.
//
// One self-scheduled renewal charge (the scheduler's first try or a dunning retry) for one
// (subscription, period). The payment row is written BEFORE the provider is called, keyed by the
// attempt, so every charge that may have moved money has a local row, and a retry of the same
// attempt re-drives the same provider idempotency key instead of charging again.
import { createHash } from 'node:crypto';
import { Clock, Notifier, Operation, Payment, PaymentProvider, PlanPrice, ProviderError, Repo, Subscription } from 'boilpayment-core';
import type { Period } from 'boilpayment-core';
import { scopeProvider } from './internal.js';

const DAY_MS = 86_400_000;

function sha256(input: string): string {
  return createHash('sha256').update(input).digest('hex');
}

/** EC:A35 — the key of the scheduler's charge for a period (unchanged from earlier releases). */
export function renewalAttemptKey(sub: Pick<Subscription, 'id'>, period: Period): string {
  return `charge:${sub.id}:${period.start.toISOString()}`;
}

/** EC:A35 — dunning retry n for a period (the period is part of the key: next month's retry 1 is a new charge). */
export function dunningAttemptKey(sub: Pick<Subscription, 'id'>, period: Period, attempt: number): string {
  return `dunning-retry:${sub.id}:${period.start.toISOString()}:${attempt}`;
}

/**
 * EC:A35 — the orderId sent to the provider for an attempt key. Toss requires 6–64 characters of
 * [A-Za-z0-9_-]; PortOne uses it as the paymentId path segment. `ord_` + 40 hex characters fits both
 * and is the same scheme hosted checkout already uses.
 */
export function providerOrderId(attemptKey: string): string {
  return 'ord_' + sha256(attemptKey).slice(0, 40);
}

/** EC:A34 — the local payment row id for an attempt: found again without a scan, on every retry. */
export function attemptPaymentId(attemptKey: string): string {
  return 'pay_rn_' + sha256(attemptKey).slice(0, 32);
}

/**
 * EC:A34 — the provider refused the request (a decline) vs. an outcome nobody knows: a 5xx, a
 * timeout (408), a conflict (409) or rate limit (429), or no answer at all prove nothing about
 * whether the money moved.
 */
export function isDecline(err: unknown): err is ProviderError {
  if (!(err instanceof ProviderError)) return false;
  const status = err.httpStatus;
  if (status === undefined) return err.failure.code !== 'provider_unavailable';
  return status >= 400 && status < 500 && status !== 408 && status !== 409 && status !== 429;
}

/** Every attempt row of one (subscription, period), oldest first. */
export async function attemptsFor(repo: Repo, sub: Pick<Subscription, 'id'>, period: Period): Promise<Payment[]> {
  const rows = await repo.payments.list({ subscriptionId: sub.id } as Partial<Payment>);
  return rows
    // A row the previous release wrote for this renewal used the attempt key itself as orderId/providerRef.
    .filter((p) => p.kind === 'subscription' &&
      (p.period?.start.getTime() === period.start.getTime() || p.providerRef === renewalAttemptKey(sub, period)))
    .sort((a, b) => a.occurredAt.getTime() - b.occurredAt.getTime());
}

/** The attempt key a stored row was written for (kept in `raw`, see chargeAttempt). */
export function attemptKeyOf(row: Payment): string | null {
  const raw = row.raw as { boilpaymentAttemptKey?: unknown } | undefined;
  return typeof raw?.boilpaymentAttemptKey === 'string' ? raw.boilpaymentAttemptKey : null;
}

/**
 * EC:A37 — one caller at a time per attempt. Two workers (two scheduler ticks, a tick and a dunning
 * retry, a webhook) must not both call the provider for the same attempt or write its row from a
 * stale read: the row is only read, created, charged and finalised under this lease. The lease is an
 * `operations` row claimed atomically (insert, or re-claim of a released one); a holder that crashed
 * leaves a stale lease that the next caller takes over after LEASE_MS.
 */
export const ATTEMPT_LEASE_MS = 10 * 60_000;
const LEASE_HASH = 'charge-attempt-lease';

function leaseKey(attemptKey: string): string {
  return `charge-lease:${attemptKey}`;
}

interface LeaseInfo { leaseUntil?: string; unleasedSince?: string }

function leaseIsStale(current: Operation, now: Date): boolean {
  const info = (current.result as LeaseInfo | null) ?? {};
  if (info.leaseUntil) return new Date(info.leaseUntil).getTime() <= now.getTime();
  if (info.unleasedSince) return new Date(info.unleasedSince).getTime() + ATTEMPT_LEASE_MS <= now.getTime();
  return false;
}

export async function withAttemptLease<T>(repo: Repo, clock: Clock, attemptKey: string, fn: () => Promise<T>): Promise<{ held: true; value: T } | { held: false }> {
  const key = leaseKey(attemptKey);
  const now = clock.now();
  const row: Operation = {
    id: key, key, kind: 'lifecycle.charge_attempt', payloadHash: LEASE_HASH, status: 'in_progress',
    result: null, error: null, createdAt: now, completedAt: null, attempts: 0,
  };
  let claimed = await repo.operations.claim(row);
  if (!claimed) {
    const current = await repo.operations.get(key);
    if (current && current.status === 'in_progress' && leaseIsStale(current, now)) {
      // A stale lease (its holder died mid-call): release it, then compete for it like everyone else.
      await repo.operations.put({ ...current, status: 'failed', error: 'lease_expired', completedAt: now });
      claimed = await repo.operations.claim(row);
    } else if (current && current.status === 'in_progress' && !(current.result as LeaseInfo | null)?.leaseUntil &&
        !(current.result as LeaseInfo | null)?.unleasedSince) {
      // Claimed but its lease time not written yet (the holder is between two statements, or died
      // there): remember when this was first seen; it is only taken over LEASE_MS later.
      await repo.operations.put({ ...current, result: { unleasedSince: now.toISOString() } });
    }
  }
  if (!claimed) return { held: false };
  await repo.operations.put({ ...claimed, result: { leaseUntil: new Date(now.getTime() + ATTEMPT_LEASE_MS).toISOString() } });
  try {
    return { held: true, value: await fn() };
  } finally {
    // Released (status 'failed' is the re-claimable state of an operations row).
    const mine = await repo.operations.get(key);
    if (mine) await repo.operations.put({ ...mine, status: 'failed', error: null, result: null, completedAt: clock.now() });
  }
}

export type ChargeAttemptOutcome =
  /** The provider took the money; the row is stored as succeeded with the paid period. */
  | { kind: 'succeeded'; payment: Payment }
  /** The provider refused. `fresh` is false when this is the stored answer of an earlier call. */
  | { kind: 'declined'; payment: Payment; fresh: boolean }
  /** Nobody knows yet (pending, requires_action, transport error). The row stays pending. */
  | { kind: 'unresolved'; payment: Payment; reason: string; first: boolean }
  /** EC:A37 — another caller holds this attempt right now; nothing was read, charged or written. */
  | { kind: 'in_flight' };

export interface ChargeAttemptInput {
  provider: PaymentProvider;
  repo: Repo;
  clock: Clock;
  sub: Subscription;
  price: PlanPrice;
  period: Period;
  attemptKey: string;
  correlationId?: string;
}

/**
 * EC:A34 — run (or re-drive) one attempt. A succeeded or failed row is the final answer and the
 * provider is not called again. A pending row, or no row, calls the provider with the attempt's
 * idempotency key and orderId: Toss replays the stored answer for a repeated Idempotency-Key and
 * PortOne answers ALREADY_PAID for a paid paymentId (its adapter returns that payment), so a
 * re-drive never charges twice.
 */
export async function chargeAttempt(input: ChargeAttemptInput): Promise<ChargeAttemptOutcome> {
  const leased = await withAttemptLease(input.repo, input.clock, input.attemptKey, () => chargeAttemptHeld(input));
  return leased.held ? leased.value : { kind: 'in_flight' };
}

async function chargeAttemptHeld(input: ChargeAttemptInput): Promise<ChargeAttemptOutcome> {
  const { provider, repo, clock, sub, price, period, attemptKey } = input;
  const id = attemptPaymentId(attemptKey);
  const orderId = providerOrderId(attemptKey);
  const stored = await repo.payments.get(id);
  if (stored?.status === 'succeeded') return { kind: 'succeeded', payment: stored };
  if (stored?.status === 'failed') return { kind: 'declined', payment: stored, fresh: false };

  const pending: Payment = stored ?? {
    id,
    customerId: sub.customerId,
    provider: sub.provider,
    providerRef: orderId,
    subscriptionId: sub.id,
    amount: { amountMinor: price.amountMinor, currency: price.currency },
    status: 'pending',
    kind: 'subscription',
    period,
    occurredAt: clock.now(),
    failure: null,
    cashReceipt: null,
    raw: { boilpaymentAttemptKey: attemptKey },
  };
  if (!stored) await repo.payments.put(pending); // durable before the provider is asked

  let answer: Payment;
  try {
    answer = await scopeProvider(provider, input.correlationId).chargeBillingKey({
      billingKey: sub.billingKey as string,
      amount: { amountMinor: price.amountMinor, currency: price.currency },
      orderId,
      customerRef: sub.customerId,
      idempotencyKey: attemptKey,
    });
  } catch (err) {
    if (isDecline(err)) {
      const failed: Payment = { ...pending, status: 'failed', failure: err.failure };
      await repo.payments.put(failed);
      return { kind: 'declined', payment: failed, fresh: true };
    }
    return { kind: 'unresolved', payment: pending, reason: err instanceof Error ? err.message : String(err), first: !stored };
  }

  const row: Payment = {
    ...pending,
    providerRef: answer.providerRef || pending.providerRef,
    amount: answer.amount ?? pending.amount,
    status: answer.status,
    occurredAt: answer.occurredAt ?? pending.occurredAt,
    failure: answer.failure,
    raw: { boilpaymentAttemptKey: attemptKey, provider: answer.raw ?? null },
  };
  await repo.payments.put(row);
  switch (row.status) {
    case 'succeeded':
      return { kind: 'succeeded', payment: row };
    case 'failed':
      return { kind: 'declined', payment: row, fresh: true };
    default:
      return { kind: 'unresolved', payment: row, reason: `provider status ${row.status}`, first: !stored };
  }
}

/**
 * EC:A36 — a renewal whose charge outcome is unknown past the period end does not keep full
 * access: the subscription enters grace (past_due, graceUntil) exactly once and a person is told
 * once. Every scheduler tick re-drives the same attempt; when the provider answers, the renewal
 * completes (succeeded) or dunning continues (declined). Grace expiry is the existing dunningSweep.
 */
export async function markUnresolved(input: {
  sub: Subscription; repo: Repo; notifier: Notifier; clock: Clock; graceDays: number; payment: Payment; reason: string;
}): Promise<Subscription> {
  const { sub, repo, notifier, clock, graceDays, payment, reason } = input;
  if (sub.status !== 'active') return sub;
  const now = clock.now();
  const updated: Subscription = { ...sub, status: 'past_due', graceUntil: new Date(now.getTime() + Math.max(0, graceDays) * DAY_MS) };
  await repo.subscriptions.put(updated);
  await notifier.send({
    type: 'cs.needs_human',
    customerId: sub.customerId,
    payload: { kind: 'renewal_charge_unresolved', subscriptionId: sub.id, paymentId: payment.id, providerRef: payment.providerRef, reason },
  });
  return updated;
}

/**
 * EC:A38 — settle an attempt row whose outcome was unknown, WITHOUT charging: ask the provider for the
 * order by its orderId (`getPaymentByOrderId`). Used for attempts the scheduler/dunning no longer
 * re-drive (the subscription expired or was canceled while the answer was pending) and for charges a
 * previous release made without a row. Returns the settled row, or null when the provider cannot say
 * yet (no lookup support, transport error). A provider that does not know the order (null) means the
 * request never arrived: the row is closed as failed, so it is never charged by anyone later.
 */
export async function settleAttemptByLookup(input: {
  provider: PaymentProvider; repo: Repo; clock: Clock; row: Payment;
}): Promise<Payment | null> {
  const { provider, repo, clock, row } = input;
  const key = attemptKeyOf(row) ?? row.id;
  const leased = await withAttemptLease(repo, clock, key, async () => {
    const fresh = (await repo.payments.get(row.id)) ?? row;
    if (fresh.status === 'succeeded' || fresh.status === 'failed') return fresh;
    if (typeof provider.getPaymentByOrderId !== 'function') return null;
    let found: Payment | null;
    try {
      found = await provider.getPaymentByOrderId(orderIdOf(fresh));
    } catch {
      return null;
    }
    const settled: Payment = found
      ? { ...fresh, providerRef: found.providerRef || fresh.providerRef, amount: found.amount ?? fresh.amount, status: found.status,
          failure: found.failure, raw: { ...(fresh.raw as object | undefined ?? {}), provider: found.raw ?? null } }
      : { ...fresh, status: 'failed', failure: { code: 'order_not_found', providerCode: null, retryable: false, userMessage: 'The provider has no order for this attempt.' } };
    if (settled.status === 'pending') return null;
    await repo.payments.put(settled);
    return settled;
  });
  return leased.held ? leased.value : null;
}

/** The orderId an attempt row was sent with (rows of earlier releases used the attempt key itself). */
export function orderIdOf(row: Payment): string {
  const key = attemptKeyOf(row);
  const legacy = (row.raw as { boilpaymentLegacyOrderId?: unknown } | undefined)?.boilpaymentLegacyOrderId;
  if (typeof legacy === 'string') return legacy;
  return key ? providerOrderId(key) : row.providerRef;
}
