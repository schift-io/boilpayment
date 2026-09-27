// spec: packages/lifecycle/spec/lifecycle.pseudo.md — EC:A26 A34 A35 A36
// EC:A26 — Toss sends no webhook for billing payments, so the renewal's payment row is stored here.
//
// One self-scheduled renewal charge (the scheduler's first try or a dunning retry) for one
// (subscription, period). The payment row is written BEFORE the provider is called, keyed by the
// attempt, so every charge that may have moved money has a local row, and a retry of the same
// attempt re-drives the same provider idempotency key instead of charging again.
import { createHash } from 'node:crypto';
import { Clock, Money, NoopNotifier, Notifier, Operation, Payment, PaymentProvider, PlanPrice, ProviderError, Repo, Subscription, keyMatchesInstant,
  expectedAttemptAmount, holdAttemptForReview, isLegacyAttemptRow, isUnderReview, lookupMismatch,
} from 'boilpayment-core';
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
  if (isDuplicateOrder(err)) return false; // EC:A49 — the order exists: it may well have been paid
  const status = err.httpStatus;
  if (status === undefined) return err.failure.code !== 'provider_unavailable';
  return status >= 400 && status < 500 && status !== 408 && status !== 409 && status !== 429;
}

/**
 * EC:A49 — the provider refused the request because the orderId / paymentId was already used (Toss
 * DUPLICATED_ORDER_ID and ALREADY_PROCESSED_PAYMENT after its 15-day Idempotency-Key window, PortOne
 * ALREADY_PAID). The order exists and may have moved money: it is settled by lookup, never a decline.
 */
const DUPLICATE_ORDER_CODES = new Set(['DUPLICATED_ORDER_ID', 'ALREADY_PROCESSED_PAYMENT', 'ALREADY_PAID']);
export function isDuplicateOrder(err: unknown): boolean {
  if (!(err instanceof ProviderError)) return false;
  const d = (err.details ?? {}) as { code?: unknown; type?: unknown };
  return [d.code, d.type, err.failure.providerCode].some((c) => typeof c === 'string' && DUPLICATE_ORDER_CODES.has(c));
}

// EC:A50 — the match rules and the review hold live in core (the webhook's A45 branch applies them too).
export { isUnderReview, lookupMismatch } from 'boilpayment-core';

/**
 * EC:A49 A50 — apply a looked-up order to an attempt row. Returns the settled row, or null when it is
 * still pending at the provider or does not match (then held for review, one notice).
 * A6-3 — the order must match what was sent under this attempt's key (the row's amount), never today's
 * plan price. A legacy row (an earlier release's charge, amount unknown) settles at the provider's
 * amount when currency and customer match; a person is told when that differs from `priceHint`.
 */
async function applyLookup(repo: Repo, notifier: Notifier, row: Payment, found: Payment, priceHint: Money | null): Promise<Payment | null> {
  const legacy = isLegacyAttemptRow(row);
  const expected = legacy ? null : (expectedAttemptAmount(row) ?? priceHint);
  const reason = lookupMismatch(found, { amount: expected, customerId: row.customerId, currency: row.amount.currency });
  if (reason) {
    await holdAttemptForReview(repo, notifier, row, found, reason);
    return null;
  }
  if (found.status !== 'succeeded' && found.status !== 'failed') return null;
  const settled: Payment = { ...row, providerRef: found.providerRef || row.providerRef, amount: found.amount ?? row.amount, status: found.status,
    failure: found.failure, raw: { ...(row.raw as object | undefined ?? {}), provider: found.raw ?? null } };
  await repo.payments.put(settled);
  if (legacy && settled.status === 'succeeded' && priceHint && found.amount && found.amount.amountMinor !== priceHint.amountMinor) {
    await notifier.send({ type: 'cs.needs_human', customerId: row.customerId, payload: {
      kind: 'legacy_settled_at_provider_amount', subscriptionId: row.subscriptionId, paymentId: row.id,
      amount: found.amount, planPrice: priceHint } });
  }
  return settled;
}

const NOT_FOUND_FAILURE = { code: 'order_not_found', providerCode: null, retryable: false, userMessage: 'The provider has no order for this attempt.' } as const;

/**
 * EC:A49 — without a lookup, a pending attempt is re-sent with its key only while the provider still
 * replays that key (Toss: 15 days). Past that, re-sending could create a second charge.
 */
export const REDRIVE_WITHOUT_LOOKUP_MS = 14 * DAY_MS;

/** Every attempt row of one (subscription, period), oldest first. */
export async function attemptsFor(repo: Repo, sub: Pick<Subscription, 'id'>, period: Period): Promise<Payment[]> {
  const rows = await repo.payments.list({ subscriptionId: sub.id } as Partial<Payment>);
  return rows
    // A row the previous release wrote for this renewal used the attempt key itself as orderId/providerRef.
    .filter((p) => p.kind === 'subscription' &&
      (p.period?.start.getTime() === period.start.getTime() || p.providerRef === renewalAttemptKey(sub, period)
        || keyMatchesInstant(p.providerRef, `charge:${sub.id}:`, period.start))) // EC:J11 — Python '+00:00' forms
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

interface LeaseInfo { leaseUntil?: string; unleasedSince?: string; token?: string }
let leaseSeq = 0;

function leaseIsStale(current: Operation, now: Date): boolean {
  const info = (current.result as LeaseInfo | null) ?? {};
  if (info.leaseUntil) return new Date(info.leaseUntil).getTime() <= now.getTime();
  if (info.unleasedSince) return new Date(info.unleasedSince).getTime() + ATTEMPT_LEASE_MS <= now.getTime();
  return false;
}

export async function withAttemptLease<T>(repo: Repo, clock: Clock, attemptKey: string, fn: () => Promise<T>): Promise<{ held: true; value: T } | { held: false }> {
  const key = leaseKey(attemptKey);
  const now = clock.now();
  // EC:A48 (I-1) — the lease and its owner token are written by the claim itself, so a claimed row never
  // shows the bare {in_progress, null} value a late 'unleasedSince' writer could mistake for a stuck claim.
  const token = `${now.getTime().toString(36)}.${(leaseSeq += 1).toString(36)}.${Math.random().toString(36).slice(2, 10)}`;
  const lease: LeaseInfo = { leaseUntil: new Date(now.getTime() + ATTEMPT_LEASE_MS).toISOString(), token };
  const row: Operation = {
    id: key, key, kind: 'lifecycle.charge_attempt', payloadHash: LEASE_HASH, status: 'in_progress',
    result: lease, error: null, createdAt: now, completedAt: null, attempts: 0,
  };
  const ops = repo.operations;
  // EC:A48 — every takeover and release is a compare and set against the row as read, so two callers
  // that saw the same stale lease cannot both take it, and a holder whose lease was taken over cannot
  // release the new holder's lease. A Repo without compareAndSet keeps the plain writes.
  const cas = typeof ops.compareAndSet === 'function' ? ops.compareAndSet.bind(ops) : null;
  const write = async (expected: Operation, next: Operation) => (cas ? cas(expected, next) : (await ops.put(next), true));
  let claimed = await ops.claim(row);
  if (!claimed) {
    const current = await ops.get(key);
    if (current && current.status === 'in_progress' && leaseIsStale(current, now)) {
      // A stale lease (its holder died mid-call): release it, then compete for it like everyone else.
      if (await write(current, { ...current, status: 'failed', error: 'lease_expired', result: null, completedAt: now })) claimed = await ops.claim(row);
    } else if (current && current.status === 'in_progress' && !(current.result as LeaseInfo | null)?.leaseUntil &&
        !(current.result as LeaseInfo | null)?.unleasedSince) {
      // Claimed but its lease time not written yet (the holder is between two statements, or died
      // there): remember when this was first seen; it is only taken over LEASE_MS later.
      await write(current, { ...current, result: { unleasedSince: now.toISOString() } });
    }
  }
  if (!claimed) return { held: false };
  // A Repo whose claim does not store the result (written before EC:A48 I-1) gets the lease as a second write.
  let held: Operation = claimed;
  if ((claimed.result as LeaseInfo | null)?.token !== token) {
    held = { ...claimed, result: lease };
    if (!(await write(claimed, held))) return { held: false };
  }
  try {
    return { held: true, value: await fn() };
  } finally {
    // Released (status 'failed' is the re-claimable state of an operations row) — only our own lease.
    const released: Operation = { ...held, status: 'failed', error: null, result: null, completedAt: clock.now() };
    if (cas) await cas(held, released);
    else {
      const mine = await ops.get(key);
      if (mine && (mine.result as LeaseInfo | null)?.token === token) await ops.put(released);
    }
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
  notifier?: Notifier;
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
  const notifier = input.notifier ?? new NoopNotifier();
  const stored = await repo.payments.get(id);
  if (stored?.status === 'succeeded') return { kind: 'succeeded', payment: stored };
  if (stored?.status === 'failed') return { kind: 'declined', payment: stored, fresh: false };
  if (stored && isUnderReview(stored)) return { kind: 'unresolved', payment: stored, reason: 'attempt_needs_review', first: false };
  if (stored) {
    // EC:A49 — a re-drive asks the provider first: the earlier call may have been paid (its answer
    // lost), and past the key-replay window a re-send would be a new charge.
    const asked = await askProvider(input, stored, notifier, { amountMinor: price.amountMinor, currency: price.currency }); // price is only a hint: the row's amount decides (A6-3)
    if (asked) return asked;
  }

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
      // A6-3 — a re-drive re-sends what its key was first sent with (the row), not today's price.
      amount: { ...pending.amount },
      orderId,
      customerRef: sub.customerId,
      idempotencyKey: attemptKey,
    });
  } catch (err) {
    if (isDuplicateOrder(err)) {
      // EC:A49 — the orderId already exists at the provider: settle from the order itself.
      const asked = await askProvider(input, pending, notifier, pending.amount, true);
      return asked ?? { kind: 'unresolved', payment: pending, reason: 'duplicate_order_unverified', first: !stored };
    }
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
 * EC:A49 — settle a re-driven attempt from the provider's own record of the order. Returns an outcome
 * when the attempt is settled or must stay unresolved; null when the provider has no such order (the
 * earlier request never arrived), so sending it with the same key is safe.
 */
async function askProvider(input: ChargeAttemptInput, row: Payment, notifier: Notifier, expected: Money, mustExist = false): Promise<ChargeAttemptOutcome | null> {
  const { provider, repo, clock } = input;
  if (typeof provider.getPaymentByOrderId !== 'function') {
    if (mustExist) return { kind: 'unresolved', payment: row, reason: 'duplicate_order_no_lookup', first: false };
    if (clock.now().getTime() - row.occurredAt.getTime() > REDRIVE_WITHOUT_LOOKUP_MS) {
      return { kind: 'unresolved', payment: row, reason: 'beyond_replay_window_no_lookup', first: false };
    }
    return null;
  }
  let found: Payment | null;
  try {
    found = await provider.getPaymentByOrderId(orderIdOf(row));
  } catch (err) {
    return { kind: 'unresolved', payment: row, reason: `lookup failed: ${err instanceof Error ? err.message : String(err)}`, first: false };
  }
  if (!found) return mustExist ? { kind: 'unresolved', payment: row, reason: 'duplicate_order_not_found', first: false } : null;
  const settled = await applyLookup(repo, notifier, row, found, expected);
  if (!settled) return { kind: 'unresolved', payment: (await repo.payments.get(row.id)) ?? row, reason: isUnderReview((await repo.payments.get(row.id)) ?? row) ? 'attempt_needs_review' : `provider status ${found.status}`, first: false };
  return settled.status === 'succeeded' ? { kind: 'succeeded', payment: settled } : { kind: 'declined', payment: settled, fresh: true };
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
  provider: PaymentProvider; repo: Repo; clock: Clock; row: Payment; expected?: Money | null; notifier?: Notifier;
}): Promise<Payment | null> {
  const { provider, repo, clock, row } = input;
  const notifier = input.notifier ?? new NoopNotifier();
  const key = attemptKeyOf(row) ?? row.id;
  const leased = await withAttemptLease(repo, clock, key, async () => {
    const fresh = (await repo.payments.get(row.id)) ?? row;
    if (fresh.status === 'succeeded' || fresh.status === 'failed') return fresh;
    if (isUnderReview(fresh)) return null; // EC:A50 — a person decides
    if (typeof provider.getPaymentByOrderId !== 'function') return null;
    let found: Payment | null;
    try {
      found = await provider.getPaymentByOrderId(orderIdOf(fresh));
    } catch {
      return null;
    }
    if (!found) {
      const closed: Payment = { ...fresh, status: 'failed', failure: { ...NOT_FOUND_FAILURE } };
      await repo.payments.put(closed);
      return closed;
    }
    return applyLookup(repo, notifier, fresh, found, input.expected ?? null);
  });
  return leased.held ? leased.value : null;
}

/**
 * EC:A39 — a row standing for a charge an earlier release made (orderId = the key itself). It is
 * settled only by lookup, never re-driven: a provider replays an idempotency key for a limited time
 * (Toss: 15 days), so re-sending it later could charge again.
 */
export function isLegacyAttempt(row: Payment): boolean {
  return isLegacyAttemptRow(row);
}

/** The orderId an attempt row was sent with (rows of earlier releases used the attempt key itself). */
export function orderIdOf(row: Payment): string {
  const key = attemptKeyOf(row);
  const legacy = (row.raw as { boilpaymentLegacyOrderId?: unknown } | undefined)?.boilpaymentLegacyOrderId;
  if (typeof legacy === 'string') return legacy;
  return key ? providerOrderId(key) : row.providerRef;
}
