// spec: packages/lifecycle/spec/lifecycle.pseudo.md — EC:M1 EC:M2 EC:M3 EC:M4
//
// Brings customers who were already paying before the kit was installed into the kit's tables, so
// the next renewal webhook / scheduler tick finds a local subscription instead of
// `unknown_provider_ref`. Input is a file the developer exports from their old system; the
// provider stays the source of truth for anything it knows (status, period, owner).
import type {
  Clock,
  Customer,
  IdGen,
  LedgerStore,
  PaymentProvider,
  ProviderName,
  Repo,
  Subscription,
} from "boilpayment-core";
import { civilDayOf } from "boilpayment-core";

const PROVIDERS: readonly ProviderName[] = [
  "stripe",
  "toss",
  "portone",
  "polar",
];
const LIVE_STATUSES = new Set(["trialing", "active", "past_due"]);

export interface BackfillRow {
  customerId: string;
  email: string | null;
  provider: ProviderName;
  /** The customer's id at the provider (Stripe `cus_…`, Polar customer id, Toss/PortOne customer key). */
  customerRef: string;
  /** Native providers (Stripe, Polar): the provider subscription id. */
  subscriptionRef: string | null;
  planId: string | null;
  /** Self-scheduled providers (Toss, PortOne): billing key plus the period already paid for. */
  billingKey: string | null;
  periodStart: Date | null;
  periodEnd: Date | null;
  /** EC:A28 — the currency the customer pays in; needed for plans priced in several currencies. */
  currency?: string | null;
  /** Credit balance carried over from the old system (paid pool). */
  credits: number | null;
  creditsExpireAt: Date | null;
}

export interface BackfillInput {
  rows: BackfillRow[];
  repo: Repo;
  ledger: LedgerStore;
  providers: Partial<Record<ProviderName, PaymentProvider>>;
  clock: Clock;
  ids: IdGen;
  /** EC:A81 — policy timezone (`policy.period.timezone`); the anchor day is the period start's civil day there. Default UTC. */
  timezone?: string;
}

export type BackfillOutcome = "created" | "updated" | "skipped" | "none";

export interface BackfillRowResult {
  /** 1-based position in the input. */
  row: number;
  customerId: string;
  status: "ok" | "error";
  /** Error code when status = 'error'; nothing was written for that row. */
  reason: string | null;
  customer: BackfillOutcome;
  subscription: BackfillOutcome;
  credits: BackfillOutcome;
  subscriptionId: string | null;
}

export interface BackfillReport {
  results: BackfillRowResult[];
  ok: number;
  errors: number;
}

class RowError extends Error {}

function fail(reason: string): never {
  throw new RowError(reason);
}

interface RowPlan {
  subscription: Omit<Subscription, "id" | "version" | "createdAt"> | null;
  existingSubscriptionId: string | null;
}

// EC:M2 EC:M3 — everything that can refuse a row happens here, before any write.
async function planRow(input: BackfillInput, row: BackfillRow): Promise<RowPlan> {
  if (!row.customerId) fail("missing_customer_id");
  if (!PROVIDERS.includes(row.provider)) fail("unknown_provider");
  const provider = input.providers[row.provider];
  if (!provider) fail("provider_not_configured");
  if (!row.customerRef) fail("missing_customer_ref");
  if (
    row.credits !== null &&
    (!Number.isInteger(row.credits) || row.credits < 0)
  )
    fail("invalid_credits");
  if (row.planId && !(await input.repo.plans.get(row.planId)))
    fail("unknown_plan");

  const native = provider.capabilities().nativeSubscriptions;
  if (row.subscriptionRef && row.billingKey)
    fail("subscription_ref_and_billing_key");
  if (!row.subscriptionRef && !row.billingKey)
    return { subscription: null, existingSubscriptionId: null };
  if (!row.planId) fail("missing_plan_id");

  if (row.subscriptionRef) {
    if (!native) fail("provider_has_no_native_subscriptions");
    const [local] = await input.repo.subscriptions.list({
      provider: row.provider,
      providerRef: row.subscriptionRef,
    });
    if (local) {
      if (local.customerId !== row.customerId)
        fail("subscription_owned_by_other_customer");
      return { subscription: null, existingSubscriptionId: local.id };
    }
    // EC:M3 — the provider decides status, period and owner; the file only names the subscription.
    const remote = await provider.getSubscription(row.subscriptionRef);
    if (
      remote.customerId !== row.customerRef &&
      remote.customerId !== row.customerId
    )
      fail("provider_customer_mismatch");
    if (!LIVE_STATUSES.has(remote.status)) fail("subscription_not_live");
    return {
      existingSubscriptionId: null,
      subscription: {
        customerId: row.customerId,
        planId: row.planId!,
        provider: row.provider,
        providerRef: row.subscriptionRef,
        status: remote.status,
        currentPeriod: remote.currentPeriod,
        anchorDay: remote.anchorDay,
        cancelAtPeriodEnd: remote.cancelAtPeriodEnd,
        graceUntil: null,
        billingKey: null,
        scheduledPlanId: null,
        currency: remote.currency ?? (await singlePriceCurrency(input, row.planId!)), // EC:A28
      },
    };
  }

  if (native) fail("billing_key_needs_self_scheduled_provider");
  if (!row.periodStart || !row.periodEnd || !(row.periodStart < row.periodEnd))
    fail("invalid_period");
  // EC:A64 — a billing key charges the card it was issued for: one already on another customer's
  // subscription is refused (a copy-paste in the file would renew this customer on that card).
  const holders = (await input.repo.subscriptions.list({ provider: row.provider })).filter(
    (s) => s.billingKey === row.billingKey && s.customerId !== row.customerId,
  );
  if (holders.length > 0) fail("billing_key_owned_by_other_customer");
  const mine = await input.repo.subscriptions.list({
    customerId: row.customerId,
    provider: row.provider,
  });
  const same = mine.find((s) => s.billingKey === row.billingKey);
  if (same) return { subscription: null, existingSubscriptionId: same.id };
  return {
    existingSubscriptionId: null,
    subscription: {
      customerId: row.customerId,
      planId: row.planId!,
      provider: row.provider,
      providerRef: null,
      status: "active",
      currentPeriod: { start: row.periodStart, end: row.periodEnd },
      anchorDay: civilDayOf(row.periodStart, input.timezone ?? 'UTC'), // EC:A81
      cancelAtPeriodEnd: false,
      graceUntil: null,
      billingKey: row.billingKey,
      billingCustomerRef: row.customerRef, // EC:A60 — the key was issued under this customer key
      scheduledPlanId: null,
      currency: row.currency ?? (await singlePriceCurrency(input, row.planId!)), // EC:A28
    },
  };
}

async function upsertCustomer(
  input: BackfillInput,
  row: BackfillRow,
): Promise<BackfillOutcome> {
  const existing = await input.repo.customers.get(row.customerId);
  if (!existing) {
    const customer: Customer = {
      id: row.customerId,
      email: row.email,
      providerRefs: [{ provider: row.provider, ref: row.customerRef }],
      status: "active",
      createdAt: input.clock.now(),
    };
    await input.repo.customers.put(customer);
    return "created";
  }
  if (
    existing.providerRefs.some(
      (r) => r.provider === row.provider && r.ref === row.customerRef,
    )
  )
    return "skipped";
  await input.repo.customers.put({
    ...existing,
    providerRefs: [
      ...existing.providerRefs,
      { provider: row.provider, ref: row.customerRef },
    ],
  });
  return "updated";
}

/** EC:M1-M4 — import existing paying customers. Idempotent: a re-run writes nothing new. */
export async function backfill(input: BackfillInput): Promise<BackfillReport> {
  const results: BackfillRowResult[] = [];
  for (const [i, row] of input.rows.entries()) {
    const result: BackfillRowResult = {
      row: i + 1,
      customerId: row.customerId,
      status: "ok",
      reason: null,
      customer: "none",
      subscription: "none",
      credits: "none",
      subscriptionId: null,
    };
    try {
      const plan = await planRow(input, row);
      result.customer = await upsertCustomer(input, row);
      if (plan.existingSubscriptionId) {
        result.subscription = "skipped";
        result.subscriptionId = plan.existingSubscriptionId;
      } else if (plan.subscription) {
        const sub: Subscription = {
          ...plan.subscription,
          id: input.ids.newId(),
          version: 0,
          createdAt: input.clock.now(),
        };
        await input.repo.subscriptions.put(sub);
        result.subscription = "created";
        result.subscriptionId = sub.id;
      }
      // EC:M4 — one grant per customer and pool; the idempotency key makes a re-run a no-op.
      if (row.credits) {
        const appended = await input.ledger.append({
          customerId: row.customerId,
          pool: "paid",
          kind: "grant",
          amount: row.credits,
          unitPriceMinor: null,
          currency: null,
          expiresAt: row.creditsExpireAt,
          source: "manual",
          reference: {},
          idempotencyKey: `backfill:${row.customerId}:paid`,
          actor: "backfill",
          reason: "balance carried over from the previous system",
        });
        result.credits = appended.duplicated ? "skipped" : "created";
      }
    } catch (err) {
      if (!(err instanceof RowError)) throw err;
      result.status = "error";
      result.reason = err.message;
    }
    results.push(result);
  }
  const errors = results.filter((r) => r.status === "error").length;
  return { results, ok: results.length - errors, errors };
}

export const BACKFILL_COLUMNS = [
  "customer_id",
  "email",
  "provider",
  "customer_ref",
  "subscription_ref",
  "plan_id",
  "billing_key",
  "period_start",
  "period_end",
  "credits",
  "credits_expire_at",
] as const;

function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') {
        field += '"';
        i++;
      } else if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ",") {
      row.push(field);
      field = "";
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(field);
      if (row.some((f) => f !== "")) rows.push(row);
      row = [];
      field = "";
    } else field += c;
  }
  row.push(field);
  if (row.some((f) => f !== "")) rows.push(row);
  return rows;
}

const text = (v: unknown): string | null =>
  v === null || v === undefined || String(v).trim() === ""
    ? null
    : String(v).trim();
const date = (v: unknown): Date | null => {
  const s = text(v);
  if (s === null) return null;
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) throw new Error(`invalid date: ${s}`);
  return d;
};
const int = (v: unknown): number | null => {
  const s = text(v);
  return s === null ? null : Number(s);
};

/** Reads the export file: CSV with a header row (BACKFILL_COLUMNS) or a JSON array with the same keys. */
export function parseBackfillFile(content: string): BackfillRow[] {
  const t = content.trim();
  let records: Record<string, unknown>[];
  if (t.startsWith("[")) records = JSON.parse(t) as Record<string, unknown>[];
  else {
    const [header, ...rows] = parseCsv(t);
    const cols = (header ?? []).map((h) => h.trim());
    records = rows.map((r) =>
      Object.fromEntries(cols.map((c, i) => [c, r[i] ?? ""])),
    );
  }
  return records.map((r) => ({
    customerId: text(r.customer_id) ?? "",
    email: text(r.email),
    provider: (text(r.provider) ?? "") as ProviderName,
    customerRef: text(r.customer_ref) ?? "",
    subscriptionRef: text(r.subscription_ref),
    planId: text(r.plan_id),
    billingKey: text(r.billing_key),
    periodStart: date(r.period_start),
    periodEnd: date(r.period_end),
    credits: int(r.credits),
    creditsExpireAt: date(r.credits_expire_at),
  }));
}

/** EC:A28 — a plan priced in one currency pins the subscription to it; otherwise unknown (null). */
async function singlePriceCurrency(input: BackfillInput, planId: string): Promise<string | null> {
  const plan = await input.repo.plans.get(planId);
  return plan && plan.prices.length === 1 ? plan.prices[0].currency : null;
}
