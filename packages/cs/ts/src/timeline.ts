// spec/cs.pseudo.md — EC:I9
//
// Read-side reconstruction of "what happened to this payment / where are my credits" for CS.
// Reconstructs entirely from `packages/core` doubles' `Repo`/`LedgerStore` interfaces (payments,
// ledger_entries, webhook_events, refunds, cs_cases, operations, notifications) — no new storage,
// no dependency on the audit-log layer another agent is building concurrently.
import {
  Clock, CsCase, CsCaseStatus, LedgerEntry, LedgerKind, LedgerStore, Money, Payment, PaymentStatus,
  Pool, Refund, Repo, Subscription, WebhookEventRecord, WebhookEventStatus, ZERO_DECIMAL_CURRENCIES,
} from 'boilpayment-core';

// ── Public types ─────────────────────────────────────────────────────────────────────────

export type TimelineEventKind =
  | 'payment.created' | 'payment.succeeded' | 'payment.failed' | 'payment.refunded' | 'payment.disputed'
  | 'credits.granted' | 'credits.consumed' | 'credits.revoked' | 'credits.expired' | 'credits.held'
  | 'credits.released' | 'credits.adjusted'
  | 'webhook.received' | 'webhook.processed' | 'webhook.failed'
  | 'refund.requested' | 'refund.succeeded' | 'refund.failed'
  | 'case.opened' | 'case.escalated' | 'case.resolved' | 'case.rejected'
  | 'operation.replayed'
  | 'notification.sent';

export type TimelineEventSource =
  | 'payments' | 'ledger_entries' | 'webhook_events' | 'refunds' | 'cs_cases' | 'operations' | 'notifications';

export interface TimelineRefs {
  paymentId?: string;
  subscriptionId?: string;
  caseId?: string;
  refundId?: string;
  grantId?: string;
  eventId?: string;
  /** EC:L5 — the webhook-delivery-scoped id carried on the underlying ledger row, when it has one. */
  correlationId?: string;
}

export interface TimelineEvent {
  at: Date;
  kind: TimelineEventKind;
  source: TimelineEventSource;
  /** One short human-readable line, no PII, safe to show in a CS console. */
  summary: string;
  refs: TimelineRefs;
  detail: Record<string, unknown>;
}

export interface TimelineOptions {
  customerId?: string;
  paymentId?: string;
  subscriptionId?: string;
  /** EC:L5 — "show me everything that happened in this one webhook delivery." Only the
   *  ledger_entries source carries correlationId today (see refs.correlationId), so this filters
   *  that source; it has no effect on payments/webhook_events/refunds/cs_cases/operations rows,
   *  which don't carry a correlationId of their own. */
  correlationId?: string;
  since?: Date;
  until?: Date;
  repo: Repo;
  ledger: LedgerStore;
  clock: Clock;
  /** Default 500. When exceeded, the OLDEST events are dropped (kept: the newest `limit`). */
  limit?: number;
}

export interface TimelineResult {
  events: TimelineEvent[];
  truncated: boolean;
}

const DEFAULT_LIMIT = 500;

// ── Money formatting (currency-aware minor-unit convention — packages/core/ts/src/money.ts) ────

const CURRENCY_SYMBOLS: Record<string, string> = { USD: '$', KRW: '₩', JPY: '¥', EUR: '€', GBP: '£' };

function formatMoney(m: Money): string {
  const zeroDecimal = ZERO_DECIMAL_CURRENCIES.includes(m.currency);
  const amount = zeroDecimal ? m.amountMinor : m.amountMinor / 100;
  const formatted = amount.toLocaleString('en-US', {
    minimumFractionDigits: zeroDecimal ? 0 : 2,
    maximumFractionDigits: zeroDecimal ? 0 : 2,
  });
  const symbol = CURRENCY_SYMBOLS[m.currency];
  return symbol ? `${symbol}${formatted}` : `${formatted} ${m.currency}`;
}

// ── Ledger kind -> timeline vocabulary ──────────────────────────────────────────────────────

const LEDGER_VERB: Record<LedgerKind, string> = {
  grant: 'granted', consume: 'consumed', revoke: 'revoked', expire: 'expired',
  hold: 'held', release: 'released', adjust: 'adjusted',
};
const LEDGER_EVENT_KIND: Record<LedgerKind, TimelineEventKind> = {
  grant: 'credits.granted', consume: 'credits.consumed', revoke: 'credits.revoked',
  expire: 'credits.expired', hold: 'credits.held', release: 'credits.released', adjust: 'credits.adjusted',
};

const PAYMENT_EVENT_KIND: Record<PaymentStatus, TimelineEventKind> = {
  pending: 'payment.created', requires_action: 'payment.created', succeeded: 'payment.succeeded',
  failed: 'payment.failed', refunded: 'payment.refunded', partially_refunded: 'payment.refunded',
  disputed: 'payment.disputed',
};

const WEBHOOK_EVENT_KIND: Partial<Record<WebhookEventStatus, TimelineEventKind>> = {
  received: 'webhook.received', processed: 'webhook.processed', failed: 'webhook.failed',
};

// ── Fetch helpers — degrade to [] on any duck-typing mismatch, never throw ─────────────────

async function safeList<T>(fn: () => Promise<T[]>): Promise<T[]> {
  try {
    return await fn();
  } catch {
    return [];
  }
}

async function fetchPayments(repo: Repo, opts: TimelineOptions): Promise<Payment[]> {
  const filter: Partial<Payment> = {};
  if (opts.customerId) filter.customerId = opts.customerId;
  if (opts.paymentId) filter.id = opts.paymentId;
  if (opts.subscriptionId) filter.subscriptionId = opts.subscriptionId;
  if (Object.keys(filter).length === 0) return [];
  return safeList(() => repo.payments.list(filter));
}

async function resolveCustomerIds(repo: Repo, opts: TimelineOptions, payments: Payment[]): Promise<Set<string>> {
  const ids = new Set<string>();
  if (opts.customerId) ids.add(opts.customerId);
  for (const p of payments) ids.add(p.customerId);
  if (opts.subscriptionId) {
    const subs = await safeList(() => repo.subscriptions.list({ id: opts.subscriptionId } as Partial<Subscription>));
    for (const s of subs) ids.add(s.customerId);
  }
  return ids;
}

/** Fetch rows scoped by an exact id (paymentId), else by each known customerId, else globally. */
async function fetchScoped<T>(
  byId: (() => Promise<T[]>) | null,
  byCustomer: (customerId: string) => Promise<T[]>,
  global: () => Promise<T[]>,
  customerIds: Set<string>,
): Promise<T[]> {
  if (byId) return safeList(byId);
  if (customerIds.size > 0) {
    const out: T[] = [];
    for (const cid of customerIds) out.push(...(await safeList(() => byCustomer(cid))));
    return out;
  }
  return safeList(global);
}

// ── Running balance (EC:B14-style: bucket-scoped expiry, evaluated at each entry's own time) ──

interface BucketState { expiresAt: Date | null; remaining: number }

/**
 * Mirrors InMemoryLedger's buildBuckets + unbucketedTotal + expiry rule from `balance()`, computed
 * INCREMENTALLY over `entries` (which must already be in append/chronological order) instead of
 * calling `ledger.balance()` per entry — `balance()` has no creation-time cutoff (only an expiry
 * cutoff), so calling it with an entry's own time as `now` would still include every later entry
 * already sitting in the store. Returns one running total per input entry, in the same order.
 */
function runningBalances(entries: LedgerEntry[]): number[] {
  const buckets = new Map<string, BucketState>();
  let unbucketed = 0;
  const out: number[] = [];
  for (const e of entries) {
    if (e.kind === 'grant') {
      buckets.set(e.id, { expiresAt: e.expiresAt, remaining: e.amount });
    } else {
      const gid = e.reference.grantId;
      const bucket = gid ? buckets.get(gid) : undefined;
      if (bucket) bucket.remaining += e.amount;
      else unbucketed += e.amount;
    }
    const now = e.createdAt.getTime();
    let total = unbucketed;
    for (const b of buckets.values()) {
      if (b.expiresAt !== null && b.expiresAt.getTime() <= now) continue; // EC:B14
      total += b.remaining;
    }
    out.push(total);
  }
  return out;
}

// ── Fold ─────────────────────────────────────────────────────────────────────────────────

// EC:I9 — two events can share one instant (a case is opened and its credits revoked inside the
// same call, under a clock with millisecond resolution). Sorting on time alone leaves their order
// to whichever source was folded first, so the same query could read differently twice. Break ties
// by cause-before-effect so the story always reads the way it happened.
const KIND_RANK: Record<string, number> = {
  'payment.created': 1, 'payment.succeeded': 1, 'payment.failed': 1, 'payment.refunded': 1, 'payment.disputed': 1,
  'webhook.received': 2, 'webhook.processed': 2, 'webhook.failed': 2,
  'case.opened': 3,
  'case.escalated': 4,
  'credits.granted': 5, 'credits.consumed': 5, 'credits.revoked': 5, 'credits.expired': 5,
  'credits.held': 5, 'credits.released': 5, 'credits.adjusted': 5,
  'refund.requested': 6, 'refund.succeeded': 6, 'refund.failed': 6,
  'case.resolved': 7, 'case.rejected': 7,
  'operation.replayed': 8,
  'notification.sent': 9,
};

function inWindow(at: Date, since?: Date, until?: Date): boolean {
  if (since && at.getTime() < since.getTime()) return false;
  if (until && at.getTime() > until.getTime()) return false;
  return true;
}

/**
 * cs.timeline({customerId?, paymentId?, subscriptionId?, since?, until?, repo, ledger, clock}) ->
 * {events, truncated} — folds payments/ledger_entries/webhook_events/refunds/cs_cases/operations
 * (+ notifications if duck-typed) into one time-ordered evidence trail. Never throws on a
 * missing/duck-typed table; degrades to fewer event kinds instead (EC:I9).
 */
export async function timeline(opts: TimelineOptions): Promise<TimelineResult> {
  const { repo, ledger } = opts;
  const since = opts.since;
  // NOT defaulted to clock.now(): InMemoryLedger.append() stamps createdAt with the real wall
  // clock (ignores the injected Clock — see final report), so a FixedClock set to a past test
  // date would silently filter out every real-time-stamped ledger entry. Leave `until` unbounded
  // unless the caller asks for a cutoff explicitly.
  const until = opts.until;
  const events: TimelineEvent[] = [];

  const scoped = Boolean(opts.customerId || opts.paymentId || opts.subscriptionId);

  // ── payments ──────────────────────────────────────────────────────────────────────────
  const payments = await fetchPayments(repo, opts);
  for (const p of payments) {
    if (!inWindow(p.occurredAt, since, until)) continue;
    const kind = PAYMENT_EVENT_KIND[p.status];
    const amountStr = formatMoney(p.amount);
    let summary = `payment ${p.id} ${p.status} (${amountStr})`;
    if (p.status === 'failed' && p.failure) {
      summary = `payment ${p.id} failed: ${p.failure.userMessage} (${p.failure.code})`;
    }
    events.push({
      at: p.occurredAt, kind, source: 'payments', summary,
      refs: { paymentId: p.id, subscriptionId: p.subscriptionId ?? undefined },
      detail: {
        status: p.status, amount: p.amount, kind: p.kind, provider: p.provider,
        failureCode: p.failure?.code ?? null, failureUserMessage: p.failure?.userMessage ?? null,
      },
    });
  }

  // ── customer resolution (needed for ledger_entries / cs_cases which are customer-scoped) ──
  const customerIds = await resolveCustomerIds(repo, opts, payments);

  // ── ledger_entries ────────────────────────────────────────────────────────────────────
  for (const cid of customerIds.size > 0 ? customerIds : (opts.customerId ? [opts.customerId] : [])) {
    const all = await safeList(() => ledger.entries(cid));
    const balances = runningBalances(all);
    for (let i = 0; i < all.length; i++) {
      const e = all[i];
      if (opts.paymentId && e.reference.paymentId !== opts.paymentId) continue;
      if (opts.subscriptionId && e.reference.subscriptionId !== opts.subscriptionId) continue;
      // EC:L5 — "show me everything that happened in this one delivery": narrows within whatever
      // customer/payment/subscription scope was already resolved above.
      if (opts.correlationId && e.reference.correlationId !== opts.correlationId) continue;
      if (!inWindow(e.createdAt, since, until)) continue;
      const verb = LEDGER_VERB[e.kind];
      const amount = Math.abs(e.amount);
      events.push({
        at: e.createdAt, kind: LEDGER_EVENT_KIND[e.kind], source: 'ledger_entries',
        summary: `${amount} credits ${verb} (${e.pool} pool, source: ${e.source})`,
        refs: {
          paymentId: e.reference.paymentId, subscriptionId: e.reference.subscriptionId,
          caseId: e.reference.caseId, refundId: e.reference.refundId,
          grantId: e.kind === 'grant' ? e.id : e.reference.grantId,
          correlationId: e.reference.correlationId,
        },
        detail: {
          amount: e.amount, pool: e.pool, source: e.source, balanceAfter: balances[i],
          unitPriceMinor: e.unitPriceMinor, currency: e.currency, reason: e.reason,
        },
      });
    }
  }

  // ── webhook_events ────────────────────────────────────────────────────────────────────
  // EC:I9 — WebhookEventRecord now carries customerId/paymentId/subscriptionId (filled by
  // webhook.receive/process), so a scoped query correlates directly. Rows whose local entity was
  // never resolved keep null ids and only show up in an unscoped query — that is the honest answer,
  // since we genuinely do not know whose payment they were.
  {
    const all = (await safeList(() => repo.webhookEvents.list())) as WebhookEventRecord[];
    const events_ = !scoped
      ? all
      : all.filter((w) =>
          (opts.paymentId !== undefined && w.paymentId === opts.paymentId) ||
          (opts.subscriptionId !== undefined && w.subscriptionId === opts.subscriptionId) ||
          (customerIds !== null && w.customerId != null && customerIds.has(w.customerId)));
    for (const w of events_) {
      const kind = WEBHOOK_EVENT_KIND[w.status];
      if (!kind) continue; // 'processing' | 'ignored' — not part of the vocabulary
      const at = w.status === 'received' ? w.receivedAt : (w.processedAt ?? w.receivedAt);
      if (!inWindow(at, since, until)) continue;
      let summary = `webhook ${w.provider} ${w.type} ${w.status}`;
      if (w.status === 'failed' && w.error) summary = `webhook ${w.provider} ${w.type} failed: ${w.error}`;
      events.push({
        at, kind, source: 'webhook_events', summary,
        refs: { eventId: w.id },
        detail: { provider: w.provider, type: w.type, status: w.status, error: w.error, attempts: w.attempts },
      });
    }
  }

  // ── refunds ───────────────────────────────────────────────────────────────────────────
  const refundRows = await fetchScoped<Refund>(
    opts.paymentId ? () => repo.refunds.list({ paymentId: opts.paymentId } as Partial<Refund>) : null,
    (cid) => repo.refunds.list({ customerId: cid } as Partial<Refund>),
    () => repo.refunds.list(),
    customerIds,
  );
  for (const r of refundRows) {
    if (!inWindow(r.createdAt, since, until)) continue;
    const kind: TimelineEventKind = r.status === 'pending' ? 'refund.requested'
      : r.status === 'succeeded' ? 'refund.succeeded' : 'refund.failed';
    let summary = `refund ${r.id} for ${formatMoney(r.amount)} (${r.ruleId})`;
    if (r.status === 'succeeded') summary += `, ${r.creditsRevoked} credits revoked`;
    if (r.status === 'failed' && r.failure) summary += ` -- failed: ${r.failure.userMessage}`;
    events.push({
      at: r.createdAt, kind, source: 'refunds', summary,
      refs: { paymentId: r.paymentId, refundId: r.id },
      detail: { amount: r.amount, status: r.status, ruleId: r.ruleId, creditsRevoked: r.creditsRevoked, reason: r.reason },
    });
  }

  // ── cs_cases ──────────────────────────────────────────────────────────────────────────
  const caseRows = await fetchScoped<CsCase>(
    opts.paymentId ? () => repo.csCases.list({ referenceId: opts.paymentId } as Partial<CsCase>) : null,
    (cid) => repo.csCases.list({ customerId: cid } as Partial<CsCase>),
    () => repo.csCases.list(),
    customerIds,
  );
  const HUMAN_STATUSES: CsCaseStatus[] = ['needs_human', 'resolved_human'];
  for (const c of caseRows) {
    if (inWindow(c.openedAt, since, until)) {
      events.push({
        at: c.openedAt, kind: 'case.opened', source: 'cs_cases',
        summary: `case ${c.id} opened (${c.kind})`,
        refs: { caseId: c.id }, detail: { kind: c.kind, referenceId: c.referenceId, status: c.status },
      });
      // EC:I9 finding — CsCase has no escalatedAt; approximated at openedAt (documented, see detail.approximate).
      if (HUMAN_STATUSES.includes(c.status)) {
        events.push({
          at: c.openedAt, kind: 'case.escalated', source: 'cs_cases',
          summary: `case ${c.id} escalated to a human`,
          refs: { caseId: c.id }, detail: { kind: c.kind, approximate: true },
        });
      }
    }
    if (c.resolvedAt && inWindow(c.resolvedAt, since, until)) {
      if (c.status === 'rejected') {
        events.push({
          at: c.resolvedAt, kind: 'case.rejected', source: 'cs_cases',
          summary: `case ${c.id} rejected`,
          refs: { caseId: c.id }, detail: { kind: c.kind, decision: c.decision },
        });
      } else if (c.status === 'resolved_auto' || c.status === 'resolved_human') {
        events.push({
          at: c.resolvedAt, kind: 'case.resolved', source: 'cs_cases',
          summary: `case ${c.id} resolved (${c.status === 'resolved_auto' ? 'auto' : 'human'})`,
          refs: { caseId: c.id }, detail: { kind: c.kind, by: c.status === 'resolved_auto' ? 'auto' : 'human', decision: c.decision },
        });
      }
    }
  }

  // ── operations ────────────────────────────────────────────────────────────────────────
  // EC:I9 finding — Operation has no attempts/replay counter (unlike WebhookEventRecord.attempts):
  // `runIdempotent`'s replay branch returns the cached result WITHOUT touching the row, so a row
  // replayed 5 times is byte-identical to one run once. We surface every completed idempotency-
  // guarded operation correlated to the query (by id substring match on `key`, per the EC:J5 key
  // convention) as `operation.replayed` — it proves "repeat submissions were safely deduped", which
  // is the CS-relevant fact, even though the true replay COUNT is not reconstructable. See final report.
  {
    const relevantIds = new Set<string>();
    if (opts.paymentId) relevantIds.add(opts.paymentId);
    if (opts.subscriptionId) relevantIds.add(opts.subscriptionId);
    for (const p of payments) relevantIds.add(p.id);
    for (const c of caseRows) relevantIds.add(c.id);
    const ops = await safeList(() => repo.operations.list());
    for (const op of ops) {
      if (op.status !== 'done') continue;
      const matches = !scoped || [...relevantIds].some((id) => op.key.includes(id));
      if (!matches) continue;
      const at = op.completedAt ?? op.createdAt;
      if (!inWindow(at, since, until)) continue;
      events.push({
        at, kind: 'operation.replayed', source: 'operations',
        summary: `operation ${op.kind} completed (idempotency-guarded — repeat submissions replay this result)`,
        refs: { eventId: op.key },
        detail: { key: op.key, kind: op.kind },
      });
    }
  }

  // ── notifications (only if the concrete Repo duck-types a table for them) ───────────────
  const repoAny = repo as unknown as { notifications?: { list(filter?: Record<string, unknown>): Promise<Array<Record<string, unknown>>> } };
  if (repoAny.notifications && typeof repoAny.notifications.list === 'function') {
    const rows = await safeList(() => repoAny.notifications!.list());
    for (const n of rows) {
      const at = (n.at ?? n.sentAt ?? n.createdAt) as Date | undefined;
      if (!at || !inWindow(at, since, until)) continue;
      if (opts.customerId && n.customerId !== opts.customerId) continue;
      events.push({
        at, kind: 'notification.sent', source: 'notifications',
        summary: `notification ${String(n.type ?? 'unknown')} sent`,
        refs: {}, detail: n,
      });
    }
  }

  // Array.prototype.sort is stable, so equal (time, rank) keeps the fold order — deterministic.
  events.sort((a, b) => a.at.getTime() - b.at.getTime() || (KIND_RANK[a.kind] ?? 99) - (KIND_RANK[b.kind] ?? 99));

  const limit = opts.limit ?? DEFAULT_LIMIT;
  const truncated = events.length > limit;
  const kept = truncated ? events.slice(events.length - limit) : events;
  return { events: kept, truncated };
}

// ── explain ──────────────────────────────────────────────────────────────────────────────

/** A compact narrative a support agent (or the chat widget) can read out, one line per event. */
export function explain(events: TimelineEvent[]): string[] {
  const lines: string[] = [];
  let lastBalance: number | null = null;
  for (const e of events) {
    switch (e.kind) {
      case 'payment.created':
      case 'payment.succeeded':
      case 'payment.failed':
      case 'payment.refunded':
      case 'payment.disputed': {
        const amount = e.detail.amount as Money | undefined;
        const status = String(e.detail.status ?? '');
        lines.push(amount ? `payment ${e.refs.paymentId ?? ''} ${status} (${formatMoney(amount)})` : `payment ${e.refs.paymentId ?? ''} ${status}`);
        break;
      }
      case 'credits.granted':
      case 'credits.consumed':
      case 'credits.revoked':
      case 'credits.expired':
      case 'credits.held':
      case 'credits.released':
      case 'credits.adjusted': {
        const amount = Math.abs(e.detail.amount as number);
        const verb = e.kind.split('.')[1];
        lines.push(`${amount} credits ${verb}`);
        lastBalance = e.detail.balanceAfter as number;
        break;
      }
      case 'refund.requested':
      case 'refund.succeeded':
      case 'refund.failed': {
        const amount = e.detail.amount as Money;
        const revoked = e.detail.creditsRevoked as number;
        const ruleId = String(e.detail.ruleId ?? '');
        let line = `refund ${e.refs.refundId ?? ''} for ${formatMoney(amount)} (${ruleId})`;
        if (e.kind === 'refund.succeeded' && revoked > 0) line += `, ${revoked} credits revoked`;
        if (e.kind === 'refund.failed') line += ' -- failed';
        lines.push(line);
        break;
      }
      case 'webhook.received':
      case 'webhook.processed':
      case 'webhook.failed':
        lines.push(e.summary);
        break;
      case 'case.opened':
        lines.push(`case ${e.refs.caseId ?? ''} opened`);
        break;
      case 'case.escalated':
        lines.push(`case ${e.refs.caseId ?? ''} escalated`);
        break;
      case 'case.resolved':
        lines.push(`case ${e.refs.caseId ?? ''} resolved`);
        break;
      case 'case.rejected':
        lines.push(`case ${e.refs.caseId ?? ''} rejected`);
        break;
      case 'operation.replayed':
        lines.push(`operation ${String(e.detail.kind ?? '')} replay-safe`);
        break;
      case 'notification.sent':
        lines.push(e.summary);
        break;
      default:
        lines.push(e.summary);
    }
  }
  if (lastBalance !== null) lines.push(`balance now ${lastBalance}`);
  return lines;
}
