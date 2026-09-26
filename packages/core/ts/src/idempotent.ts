/**
 * Operation-level idempotency. See spec/core.pseudo.md [EC:J1 J2 J3 J4 J5].
 * Mirrors packages/core/py/src/boilpayment_core/idempotent.py exactly.
 *
 * Design note (documents the "choose one" in the task brief): results are made JSON-safe via
 * explicit serialize-/deserialize- helpers per entity (Dates <-> ISO strings), NOT by re-reading
 * the entity from Repo/LedgerStore on replay. Re-read-by-id was preferred where it was cheap, but
 * `LedgerStore` has no `get(id)` — a `grant`/`clawback`/`revoke` LedgerEntry result cannot be
 * re-fetched by id at all — so a single consistent strategy (serialize the whole result) is used
 * for every call site instead of mixing two strategies.
 */
import { createHash } from 'node:crypto';
import { CsCase, LedgerEntry, PaymentKitError, Refund, Repo, Subscription } from './types.js';

// ── Stable JSON hashing (EC:J1/J2 — same payload vs different payload) ──────────────────────

function sortForHash(value: unknown): unknown {
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(sortForHash);
  if (value && typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    const sorted: Record<string, unknown> = {};
    for (const k of Object.keys(obj).sort()) sorted[k] = sortForHash(obj[k]);
    return sorted;
  }
  return value;
}

export function stableStringify(value: unknown): string {
  return JSON.stringify(sortForHash(value));
}

export function hashPayload(payload: unknown): string {
  return createHash('sha256').update(stableStringify(payload)).digest('hex');
}

// ── runIdempotent ─────────────────────────────────────────────────────────────────────────

export interface RunIdempotentInput<R> {
  repo: Repo;
  key: string;
  kind: string;
  payload: unknown;
  clock: { now(): Date };
  fn: () => Promise<R>;
  /** Result -> JSON-serializable. Default: identity (works for plain-JSON-shaped results). */
  serialize?: (result: R) => unknown;
  /** JSON-serializable -> Result (inverse of serialize). Default: identity. */
  deserialize?: (stored: unknown) => R;
}

export interface RunIdempotentResult<R> {
  result: R;
  replayed: boolean;
}

// EC:J1 same op retried after partial failure -> replay stored result, no re-execution.
// EC:J2 same key + different payload -> 'idempotency_key_reused'.
// EC:J3 in-flight duplicate -> 'idempotency_in_progress'.
// EC:J4 retention/TTL is documented policy (default 7 days), not enforced here — see EDGE_CASES.md §J.
export async function runIdempotent<R>(input: RunIdempotentInput<R>): Promise<RunIdempotentResult<R>> {
  const { repo, key, kind, payload, clock, fn } = input;
  const serialize = input.serialize ?? ((r: R) => r as unknown);
  const deserialize = input.deserialize ?? ((s: unknown) => s as R);
  const payloadHash = hashPayload(payload);

  const base = await repo.operations.claim({
    id: key, key, kind, payloadHash, status: 'in_progress', result: null, error: null,
    createdAt: clock.now(), completedAt: null, attempts: 1,
  });
  if (!base) {
    const existing = await repo.operations.get(key);
    if (existing && existing.payloadHash !== payloadHash) {
      throw new PaymentKitError(`idempotency key reused with a different payload: ${key}`, 'idempotency_key_reused', { key, kind: existing.kind });
    }
    if (existing?.status === 'done') {
      await repo.operations.put({ ...existing, attempts: existing.attempts + 1 });
      return { result: deserialize(existing.result), replayed: true };
    }
    throw new PaymentKitError(`operation already in progress: ${key}`, 'idempotency_in_progress', { key, kind });
  }

  try {
    const result = await fn();
    await repo.operations.put({ ...base, status: 'done', result: serialize(result), completedAt: clock.now() });
    return { result, replayed: false };
  } catch (err) {
    await repo.operations.put({
      ...base,
      status: 'failed',
      error: err instanceof Error ? err.message : String(err),
      completedAt: clock.now(),
    });
    throw err;
  }
}

// ── Entity serialize/deserialize helpers (Date <-> ISO string) ──────────────────────────────
// Used to build the `serialize`/`deserialize` pair for each wired call site's result shape.

export function serializeSubscription(s: Subscription): unknown {
  return {
    ...s,
    currentPeriod: { start: s.currentPeriod.start.toISOString(), end: s.currentPeriod.end.toISOString() },
    graceUntil: s.graceUntil ? s.graceUntil.toISOString() : null,
    createdAt: s.createdAt.toISOString(),
  };
}
export function deserializeSubscription(v: unknown): Subscription {
  const o = v as Record<string, any>;
  return {
    ...o,
    currentPeriod: { start: new Date(o.currentPeriod.start), end: new Date(o.currentPeriod.end) },
    graceUntil: o.graceUntil ? new Date(o.graceUntil) : null,
    createdAt: new Date(o.createdAt),
  } as Subscription;
}

export function serializeLedgerEntry(e: LedgerEntry | null): unknown {
  if (!e) return null;
  return {
    ...e,
    expiresAt: e.expiresAt ? e.expiresAt.toISOString() : null,
    createdAt: e.createdAt.toISOString(),
    reference: { ...e.reference, periodStart: e.reference.periodStart ? e.reference.periodStart.toISOString() : undefined },
  };
}
export function deserializeLedgerEntry(v: unknown): LedgerEntry | null {
  if (!v) return null;
  const o = v as Record<string, any>;
  return {
    ...o,
    expiresAt: o.expiresAt ? new Date(o.expiresAt) : null,
    createdAt: new Date(o.createdAt),
    reference: { ...o.reference, periodStart: o.reference?.periodStart ? new Date(o.reference.periodStart) : undefined },
  } as LedgerEntry;
}

export function serializeRefund(r: Refund): unknown {
  return { ...r, createdAt: r.createdAt.toISOString() };
}
export function deserializeRefund(v: unknown): Refund {
  const o = v as Record<string, any>;
  return { ...o, createdAt: new Date(o.createdAt) } as Refund;
}

export function serializeCsCase(c: CsCase): unknown {
  return { ...c, openedAt: c.openedAt.toISOString(), resolvedAt: c.resolvedAt ? c.resolvedAt.toISOString() : null };
}
export function deserializeCsCase(v: unknown): CsCase {
  const o = v as Record<string, any>;
  return { ...o, openedAt: new Date(o.openedAt), resolvedAt: o.resolvedAt ? new Date(o.resolvedAt) : null } as CsCase;
}
