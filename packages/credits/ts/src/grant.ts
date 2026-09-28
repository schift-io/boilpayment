// spec: packages/credits/spec/credits.pseudo.md
import {
  Clock,
  LedgerEntry,
  LedgerReference,
  LedgerSource,
  LedgerStore,
  NewLedgerEntry,
  Payment,
  Plan,
  Policy,
  Pool,
  Repo,
  Subscription,
  PaymentKitError,
  Period,
  deserializeLedgerEntry,
  runIdempotent,
  serializeLedgerEntry,
  keyMatchesInstant,
} from 'boilpayment-core';

export interface GrantResult {
  entry: LedgerEntry | null;
  duplicated: boolean;
  deferred: boolean;
  /** EC:B17 — portion of this grant redirected to settle a pre-existing negative balance. 0 when none. */
  offset: number;
  /** EC:B17 — the 'adjust' entries written to record the settlement (empty when offset === 0). */
  offsetEntries: LedgerEntry[];
}

async function writeGrant(ledger: LedgerStore, entry: NewLedgerEntry): Promise<GrantResult> {
  const { entry: written, duplicated } = await ledger.append(entry);
  return { entry: written, duplicated, deferred: false, offset: 0, offsetEntries: [] };
}

// EC:B17 — settle a negative balance against an incoming grant (policy.credits.negativeOffset ===
// 'offset_next_grant', the default; 'never' leaves the debt outstanding and this is a no-op).
//
// A negative paid-pool balance only ever exists as an UNBUCKETED ledger entry (no reference.grantId
// — see EC:A4/EC:B4 clawback('allow_negative')/consume('allow_to_floor'|'allow_unbounded')): buckets
// themselves can't go negative, only the aggregate can. Plain arithmetic already nets the aggregate
// correctly the moment the grant lands (available = oldDebt + grantAmount) — the bug this closes is
// that the FRESH GRANT'S OWN BUCKET still shows the full amount as spendable, so a consume() call
// that only checks bucket remaining (not the aggregate) can draw past the true limit. Fixing that
// needs a balanced PAIR of entries, not one: -offset tied to the new grant's bucket (caps what's
// really spendable from it — "only the remainder becomes spendable") and +offset unbucketed (retires
// the old debt so a LATER grant doesn't try to offset the same debt again). Together they net to
// zero, so the aggregate total is unchanged — only the bucket-level accounting is corrected.
async function applyNegativeOffset(input: {
  ledger: LedgerStore;
  policy: Policy;
  /** Balance BEFORE this grant was appended — the grant itself must not be counted as debt. */
  preGrantAvailable: number;
  customerId: string;
  pool: Pool;
  grant: LedgerEntry;
  source: LedgerSource;
  reference: LedgerReference;
  grantIdempotencyKey: string;
}): Promise<{ offset: number; entries: LedgerEntry[] }> {
  const { ledger, policy, preGrantAvailable, customerId, pool, grant, source, reference, grantIdempotencyKey } = input;
  if (policy.credits.negativeOffset !== 'offset_next_grant') return { offset: 0, entries: [] };
  if (preGrantAvailable >= 0) return { offset: 0, entries: [] };

  const debt = -preGrantAvailable;
  const offset = Math.min(debt, grant.amount);
  if (offset <= 0) return { offset: 0, entries: [] };

  const entries: LedgerEntry[] = [];
  const { entry: cap } = await ledger.append({
    customerId,
    pool,
    kind: 'adjust',
    amount: -offset,
    unitPriceMinor: null,
    currency: null,
    expiresAt: null,
    source,
    reference: { ...reference, grantId: grant.id },
    idempotencyKey: `offset:${grantIdempotencyKey}`,
    actor: 'system',
    reason: 'negative_balance_offset',
  });
  entries.push(cap);

  const { entry: settle } = await ledger.append({
    customerId,
    pool,
    kind: 'adjust',
    amount: offset,
    unitPriceMinor: null,
    currency: null,
    expiresAt: null,
    source,
    reference,
    idempotencyKey: `offset:${grantIdempotencyKey}:settled`,
    actor: 'system',
    reason: 'negative_balance_offset',
  });
  entries.push(settle);

  return { offset, entries };
}

// OT-17 — retain the indivisible minor-unit remainder so refund valuation can reconstruct the exact grant value.
function priceCredits(amountMinor: number, credits: number): { unitPriceMinor: number; remainderMinor: number } {
  if (credits <= 0) return { unitPriceMinor: 0, remainderMinor: amountMinor };
  const unitPriceMinor = Math.floor(amountMinor / credits);
  const remainderMinor = amountMinor - unitPriceMinor * credits;
  return { unitPriceMinor, remainderMinor };
}

// EC:B1 B2 B7 A15 — subscription-period credit grant
export interface GrantForPeriodInput {
  sub: Subscription;
  plan: Plan;
  period: Period;
  payment: Payment;
  policy: Policy;
  ledger: LedgerStore;
  clock: Clock;
  /** EC:L5 — optional delivery-scoped id, merged into `reference.correlationId` on the grant
   *  (and any EC:B17 offset) entries this call writes. */
  correlationId?: string;
}

export async function grantForPeriod(input: GrantForPeriodInput): Promise<GrantResult> {
  const { sub, plan, period, payment, policy, ledger, clock, correlationId } = input;

  // EC:A15 — defer grant while in grace/past_due unless policy says grant anyway
  if (sub.status === 'past_due' && policy.dunning.grantDuringGrace === 'defer_until_paid') {
    return { entry: null, duplicated: false, deferred: true, offset: 0, offsetEntries: [] };
  }

  // EC:B12 — deterministic key means a re-delivered webhook's retry is a no-op (ledger.append dedupes).
  const idempotencyKey = `grant:${sub.id}:${period.start.toISOString()}`;
  const amount = plan.creditsPerPeriod;
  const { unitPriceMinor, remainderMinor } = priceCredits(payment.amount.amountMinor, amount);

  // EC:B1 — rollover mode decides this grant's own expiry (banked still expires at period.end;
  // the carry-over is written separately by rolloverOnRenewal at the next renewal).
  const expiresAt: Date | null = policy.credits.rollover === 'full' ? null : period.end;

  const reference: LedgerReference = {
    subscriptionId: sub.id, periodStart: period.start, paymentId: payment.id,
    ...(correlationId ? { correlationId } : {}),
  };

  // EC:B17 — read the balance BEFORE this grant lands; querying after would already include the
  // grant amount, hiding the very debt it's supposed to offset.
  const preGrantAvailable =
    policy.credits.negativeOffset === 'offset_next_grant' ? (await ledger.balance(sub.customerId, 'paid', clock.now())).available : 0;

  // EC:J11 — a grant written for this period under an older key form (Python isoformat,
  // `+09:00`) is the same grant; never write a second one.
  const legacy = (await ledger.entries(sub.customerId, { kind: 'grant', source: 'subscription' })).find(
    (e) => e.idempotencyKey !== idempotencyKey && keyMatchesInstant(e.idempotencyKey, `grant:${sub.id}:`, period.start),
  );
  if (legacy) return { entry: legacy, duplicated: true, deferred: false, offset: 0, offsetEntries: [] };

  const result = await writeGrant(ledger, {
    customerId: sub.customerId,
    pool: 'paid',
    kind: 'grant',
    amount,
    unitPriceMinor,
    currency: payment.amount.currency,
    expiresAt,
    source: 'subscription',
    reference,
    idempotencyKey,
    actor: 'system',
    reason: remainderMinor > 0 ? `remainder_minor:${remainderMinor}` : null,
  });

  // EC:B17 — only offset a freshly-written grant, not a deduped replay of one already offset.
  if (!result.entry || result.duplicated) return result;
  const { offset, entries } = await applyNegativeOffset({
    ledger, policy, preGrantAvailable, customerId: sub.customerId, pool: 'paid',
    grant: result.entry, source: 'subscription', reference, grantIdempotencyKey: idempotencyKey,
  });
  return { ...result, offset, offsetEntries: entries };
}

// EC:B10 — one-time top-up
export interface TopupInput {
  customerId: string;
  payment: Payment;
  credits: number;
  policy: Policy;
  ledger: LedgerStore;
  clock: Clock;
  // EC:J1-J5 — optional: when provided, the grant is wrapped in runIdempotent (Operation-tracked,
  // rejects same-key/different-payload retries, in-flight duplicate detection). When omitted,
  // topup() falls back to its pre-existing behavior (ledger.append's own idempotency_key UNIQUE
  // dedup on `topup:{payment.id}`) for backward compatibility with callers that only have the
  // narrower `{customerId, payment, credits, policy, ledger, clock}` shape (e.g.
  // packages/webhook's duck-typed CreditsDeps).
  repo?: Repo;
  /** EC:J5 — default: `topup:{payment.id}` if omitted (same as the ledger-level key). */
  idempotencyKey?: string;
  /** EC:L5 — optional delivery-scoped id, merged into `reference.correlationId` on the grant
   *  (and any EC:B17 offset) entries this call writes. */
  correlationId?: string;
}

async function doTopup(input: TopupInput): Promise<GrantResult> {
  const { customerId, payment, credits, policy, ledger, clock, correlationId } = input;
  const idempotencyKey = `topup:${payment.id}`;
  const days = policy.credits.topupExpiryDays;
  const expiresAt = days === null ? null : new Date(clock.now().getTime() + days * 86_400_000);
  const { unitPriceMinor, remainderMinor } = priceCredits(payment.amount.amountMinor, credits);

  const reference: LedgerReference = { paymentId: payment.id, ...(correlationId ? { correlationId } : {}) };

  // EC:B17 — see the identical comment in grantForPeriod: must read before the grant lands.
  const preGrantAvailable =
    policy.credits.negativeOffset === 'offset_next_grant' ? (await ledger.balance(customerId, 'paid', clock.now())).available : 0;

  const result = await writeGrant(ledger, {
    customerId,
    pool: 'paid',
    kind: 'grant',
    amount: credits,
    unitPriceMinor,
    currency: payment.amount.currency,
    expiresAt,
    source: 'topup',
    reference,
    idempotencyKey,
    actor: 'system',
    reason: remainderMinor > 0 ? `remainder_minor:${remainderMinor}` : null,
  });

  // EC:B17
  if (!result.entry || result.duplicated) return result;
  const { offset, entries } = await applyNegativeOffset({
    ledger, policy, preGrantAvailable, customerId, pool: 'paid',
    grant: result.entry, source: 'topup', reference, grantIdempotencyKey: idempotencyKey,
  });
  return { ...result, offset, offsetEntries: entries };
}

// EC:J1-J5 — same operation retried after partial failure replays the first GrantResult.
export async function topup(input: TopupInput): Promise<GrantResult> {
  if (!input.repo) return doTopup(input);

  const key = input.idempotencyKey ?? `topup:${input.payment.id}`;
  const { result } = await runIdempotent<GrantResult>({
    repo: input.repo,
    clock: input.clock,
    key,
    kind: 'credits.topup',
    payload: {
      customerId: input.customerId,
      paymentId: input.payment.id,
      credits: input.credits,
      amountMinor: input.payment.amount.amountMinor,
      currency: input.payment.amount.currency,
    },
    serialize: (r) => ({
      entry: serializeLedgerEntry(r.entry),
      duplicated: r.duplicated,
      deferred: r.deferred,
      offset: r.offset,
      offsetEntries: r.offsetEntries.map(serializeLedgerEntry),
    }),
    deserialize: (v: any) => ({
      entry: deserializeLedgerEntry(v.entry),
      duplicated: v.duplicated,
      deferred: v.deferred,
      offset: v.offset ?? 0,
      offsetEntries: (v.offsetEntries ?? []).map(deserializeLedgerEntry),
    }),
    fn: () => doTopup(input),
  });
  return result;
}

/**
 * EC:B19 — default expiry for a grant source from policy.credits.expiryDays. null = never.
 * Used only when the caller passes `policy` and no expiresAt; without `policy` nothing changes.
 */
export function defaultExpiry(policy: Policy, source: 'promo' | 'trial' | 'manual' | 'regrant', now: Date): Date | null {
  const days = policy.credits.expiryDays[source];
  return days === null ? null : new Date(now.getTime() + days * 86_400_000);
}

// grantPromo / grantTrial — automated promo/trial grants (distinct from EC:B9 manual adjustments)
export interface GrantPoolInput {
  customerId: string;
  amount: number;
  ledger: LedgerStore;
  clock: Clock;
  idempotencyKey: string;
  expiresAt?: Date | null;
  reason?: string | null;
  actor?: string;
  reference?: LedgerReference;
  /** EC:B19 — pass to apply policy.credits.expiryDays when expiresAt is not given. */
  policy?: Policy;
}

async function grantPool(pool: Pool, source: 'promo' | 'trial', input: GrantPoolInput): Promise<GrantResult> {
  const { customerId, amount, ledger, idempotencyKey, reason = null, actor = 'system', reference = {} } = input;
  const expiresAt = input.expiresAt ?? (input.policy ? defaultExpiry(input.policy, source, input.clock.now()) : null);
  return writeGrant(ledger, {
    customerId,
    pool,
    kind: 'grant',
    amount,
    unitPriceMinor: null,
    currency: null,
    expiresAt,
    source,
    reference,
    idempotencyKey,
    actor,
    reason,
  });
}

export function grantPromo(input: GrantPoolInput): Promise<GrantResult> {
  return grantPool('promo', 'promo', input);
}

export function grantTrial(input: GrantPoolInput): Promise<GrantResult> {
  return grantPool('trial', 'trial', input);
}

// EC:B9 — manual admin grant/revoke. reason + actor mandatory, source is always 'manual'.
export interface ManualAdjustInput {
  customerId: string;
  pool: Pool;
  amount: number; // positive magnitude
  reason: string;
  actor: string;
  ledger: LedgerStore;
  clock: Clock;
  idempotencyKey: string;
  expiresAt?: Date | null;
  reference?: LedgerReference;
  /** EC:B19 — pass to apply policy.credits.expiryDays.manual when expiresAt is not given (grants only). */
  policy?: Policy;
}

function requireReasonAndActor(input: { reason: string; actor: string }): void {
  if (!input.reason) throw new PaymentKitError('manual credit adjustment requires reason', 'manual_adjust_invalid');
  if (!input.actor) throw new PaymentKitError('manual credit adjustment requires actor', 'manual_adjust_invalid');
}

export async function manualGrant(input: ManualAdjustInput): Promise<GrantResult> {
  requireReasonAndActor(input);
  return writeGrant(input.ledger, {
    customerId: input.customerId,
    pool: input.pool,
    kind: 'grant',
    amount: Math.abs(input.amount),
    unitPriceMinor: null,
    currency: null,
    expiresAt: input.expiresAt ?? (input.policy ? defaultExpiry(input.policy, 'manual', input.clock.now()) : null),
    source: 'manual',
    reference: input.reference ?? {},
    idempotencyKey: input.idempotencyKey,
    actor: input.actor,
    reason: input.reason,
  });
}

export async function manualRevoke(input: ManualAdjustInput): Promise<GrantResult> {
  requireReasonAndActor(input);
  return writeGrant(input.ledger, {
    customerId: input.customerId,
    pool: input.pool,
    kind: 'revoke',
    amount: -Math.abs(input.amount),
    unitPriceMinor: null,
    currency: null,
    expiresAt: null,
    source: 'manual',
    reference: input.reference ?? {},
    idempotencyKey: input.idempotencyKey,
    actor: input.actor,
    reason: input.reason,
  });
}
