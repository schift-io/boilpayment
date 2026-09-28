// EC:M1-M4 — backfill of customers who were already paying before the kit.
import { describe, expect, it } from "vitest";
import {
  FixedClock,
  InMemoryLedger,
  InMemoryRepo,
  Plan,
  SequentialIdGen,
  Subscription,
} from "boilpayment-core";
import {
  backfill,
  parseBackfillFile,
  BACKFILL_COLUMNS,
  type BackfillRow,
} from "../src/index.js";
import { FakeNativeProvider, FakeSelfSchedulingProvider } from "./helpers.js";

class RemoteSubs extends FakeNativeProvider {
  subs = new Map<string, Subscription>();
  calls = 0;
  override async getSubscription(ref: string): Promise<Subscription> {
    this.calls += 1;
    const s = this.subs.get(ref);
    if (!s) throw new Error(`no such subscription ${ref}`);
    return s;
  }
}

const NOW = new Date("2026-03-10T00:00:00.000Z");
const plan: Plan = {
  id: "pro",
  name: "Pro",
  interval: "month",
  creditsPerPeriod: 100,
  usageIncluded: 0,
  trialDays: 0,
  prices: [{ currency: "USD", amountMinor: 1000 }],
};

function remote(
  ref: string,
  customerRef: string,
  status: Subscription["status"] = "active",
): Subscription {
  return {
    id: ref,
    customerId: customerRef,
    planId: "",
    provider: "stripe",
    providerRef: ref,
    status,
    currentPeriod: {
      start: new Date("2026-03-01T00:00:00.000Z"),
      end: new Date("2026-04-01T00:00:00.000Z"),
    },
    anchorDay: 1,
    cancelAtPeriodEnd: false,
    graceUntil: null,
    billingKey: null,
    scheduledPlanId: null,
    version: 0,
    createdAt: NOW,
  };
}

function row(p: Partial<BackfillRow>): BackfillRow {
  return {
    customerId: "u1",
    email: "u1@example.com",
    provider: "stripe",
    customerRef: "cus_1",
    subscriptionRef: null,
    planId: null,
    billingKey: null,
    periodStart: null,
    periodEnd: null,
    credits: null,
    creditsExpireAt: null,
    ...p,
  };
}

async function setup() {
  const repo = new InMemoryRepo();
  await repo.plans.put(plan);
  const ledger = new InMemoryLedger(new SequentialIdGen("led_"));
  const stripe = new RemoteSubs();
  stripe.subs.set("sub_1", remote("sub_1", "cus_1"));
  stripe.subs.set("sub_other", remote("sub_other", "cus_someone_else"));
  stripe.subs.set("sub_dead", remote("sub_dead", "cus_1", "canceled"));
  const toss = new FakeSelfSchedulingProvider();
  const deps = {
    repo,
    ledger,
    providers: { stripe, toss },
    clock: new FixedClock(NOW),
    ids: new SequentialIdGen("sub_local_"),
  };
  return { ...deps, stripe };
}

describe("backfill", () => {
  it("native subscription: period and status come from the provider, not the file", async () => {
    const d = await setup();
    const report = await backfill({
      ...d,
      rows: [row({ subscriptionRef: "sub_1", planId: "pro", credits: 40 })],
    });
    expect(report).toMatchObject({ ok: 1, errors: 0 });
    expect(report.results[0]).toMatchObject({
      customer: "created",
      subscription: "created",
      credits: "created",
    });
    const [sub] = await d.repo.subscriptions.list({
      provider: "stripe",
      providerRef: "sub_1",
    });
    expect(sub).toMatchObject({
      customerId: "u1",
      planId: "pro",
      status: "active",
      anchorDay: 1,
      billingKey: null,
    });
    expect(sub.currentPeriod.end.toISOString()).toBe(
      "2026-04-01T00:00:00.000Z",
    );
    expect((await d.ledger.balance("u1", "paid", NOW)).available).toBe(40);
    expect((await d.repo.customers.get("u1"))!.providerRefs).toEqual([
      { provider: "stripe", ref: "cus_1" },
    ]);
  });

  it("re-running writes nothing new", async () => {
    const d = await setup();
    const rows = [
      row({ subscriptionRef: "sub_1", planId: "pro", credits: 40 }),
    ];
    await backfill({ ...d, rows });
    const again = await backfill({ ...d, rows });
    expect(again.results[0]).toMatchObject({
      status: "ok",
      customer: "skipped",
      subscription: "skipped",
      credits: "skipped",
    });
    expect(await d.repo.subscriptions.list()).toHaveLength(1);
    expect((await d.ledger.balance("u1", "paid", NOW)).available).toBe(40);
  });

  it("self-scheduled provider: billing key and the paid period from the file", async () => {
    const d = await setup();
    const report = await backfill({
      ...d,
      rows: [
        row({
          provider: "toss",
          customerRef: "ck_1",
          billingKey: "bk_1",
          planId: "pro",
          periodStart: new Date("2026-03-05T00:00:00Z"),
          periodEnd: new Date("2026-04-05T00:00:00Z"),
        }),
      ],
    });
    expect(report.results[0]).toMatchObject({
      status: "ok",
      subscription: "created",
    });
    const [sub] = await d.repo.subscriptions.list({
      customerId: "u1",
      provider: "toss",
    });
    expect(sub).toMatchObject({
      providerRef: null,
      billingKey: "bk_1",
      status: "active",
      anchorDay: 5,
    });
    expect(
      (
        await backfill({
          ...d,
          rows: [
            row({
              provider: "toss",
              customerRef: "ck_1",
              billingKey: "bk_1",
              planId: "pro",
              periodStart: new Date("2026-03-05T00:00:00Z"),
              periodEnd: new Date("2026-04-05T00:00:00Z"),
            }),
          ],
        })
      ).results[0].subscription,
    ).toBe("skipped");
  });

  it("a second provider for the same customer adds a provider ref", async () => {
    const d = await setup();
    await backfill({ ...d, rows: [row({ credits: 5 })] });
    const r = await backfill({
      ...d,
      rows: [row({ provider: "toss", customerRef: "ck_1" })],
    });
    expect(r.results[0].customer).toBe("updated");
    expect((await d.repo.customers.get("u1"))!.providerRefs).toHaveLength(2);
  });

  it.each([
    [{ subscriptionRef: "sub_1", planId: "enterprise" }, "unknown_plan"],
    [{ subscriptionRef: "sub_1" }, "missing_plan_id"],
    [
      { subscriptionRef: "sub_other", planId: "pro" },
      "provider_customer_mismatch",
    ],
    [{ subscriptionRef: "sub_dead", planId: "pro" }, "subscription_not_live"],
    [
      { provider: "polar" as const, subscriptionRef: "x", planId: "pro" },
      "provider_not_configured",
    ],
    [
      { billingKey: "bk", planId: "pro" },
      "billing_key_needs_self_scheduled_provider",
    ],
    [
      { provider: "toss" as const, subscriptionRef: "x", planId: "pro" },
      "provider_has_no_native_subscriptions",
    ],
    [
      { provider: "toss" as const, billingKey: "bk", planId: "pro" },
      "invalid_period",
    ],
    [{ credits: -3 }, "invalid_credits"],
  ])(
    "refuses %o with %s and writes nothing for that row",
    async (patch, reason) => {
      const d = await setup();
      const report = await backfill({
        ...d,
        rows: [row({ ...patch, credits: patch.credits ?? 10 })],
      });
      expect(report.results[0]).toMatchObject({
        status: "error",
        reason,
        customer: "none",
        credits: "none",
      });
      expect(await d.repo.customers.get("u1")).toBeNull();
      expect((await d.ledger.balance("u1", "paid", NOW)).available).toBe(0);
    },
  );

  it("a subscription already owned by another local customer is refused", async () => {
    const d = await setup();
    await backfill({
      ...d,
      rows: [row({ subscriptionRef: "sub_1", planId: "pro" })],
    });
    const r = await backfill({
      ...d,
      rows: [
        row({ customerId: "u2", subscriptionRef: "sub_1", planId: "pro" }),
      ],
    });
    expect(r.results[0]).toMatchObject({
      status: "error",
      reason: "subscription_owned_by_other_customer",
    });
  });

  it("parses CSV and JSON exports with the same columns", () => {
    const csv = `${BACKFILL_COLUMNS.join(",")}\nu1,a@b.co,stripe,cus_1,sub_1,pro,,,,"12",2026-12-31T00:00:00Z\n`;
    const [c] = parseBackfillFile(csv);
    expect(c).toMatchObject({
      customerId: "u1",
      subscriptionRef: "sub_1",
      billingKey: null,
      credits: 12,
    });
    expect(c.creditsExpireAt?.toISOString()).toBe("2026-12-31T00:00:00.000Z");
    const [j] = parseBackfillFile(
      JSON.stringify([
        {
          customer_id: "u2",
          provider: "toss",
          customer_ref: "ck",
          billing_key: "bk",
          period_start: "2026-03-01",
          period_end: "2026-04-01",
        },
      ]),
    );
    expect(j).toMatchObject({
      customerId: "u2",
      provider: "toss",
      billingKey: "bk",
      credits: null,
    });
  });
});

describe("[EC:A28] backfill sets the subscription currency", () => {
  it("[EC:A28] native: the provider's currency; self-scheduled: the row's, else the plan's only price", async () => {
    const d = await setup();
    d.stripe.subs.set("sub_1", { ...remote("sub_1", "cus_1"), currency: "KRW" });
    await backfill({ ...d, rows: [
      row({ subscriptionRef: "sub_1", planId: "pro" }),
      row({ customerId: "u2", customerRef: "ck_2", provider: "toss", planId: "pro", billingKey: "bk_2",
        periodStart: new Date("2026-03-01T00:00:00.000Z"), periodEnd: new Date("2026-04-01T00:00:00.000Z") }),
      row({ customerId: "u3", customerRef: "ck_3", provider: "toss", planId: "pro", billingKey: "bk_3", currency: "EUR",
        periodStart: new Date("2026-03-01T00:00:00.000Z"), periodEnd: new Date("2026-04-01T00:00:00.000Z") }),
    ] });
    const byCustomer = Object.fromEntries((await d.repo.subscriptions.list()).map((s) => [s.customerId, s.currency]));
    expect(byCustomer).toEqual({ u1: "KRW", u2: "USD", u3: "EUR" });
  });

  it("[EC:A81] the anchor day is the period start's civil day in the policy timezone", async () => {
    const d = await setup();
    await backfill({
      ...d,
      timezone: "Asia/Seoul",
      rows: [row({ provider: "toss", customerRef: "ck_1", billingKey: "bk_1", planId: "pro",
        periodStart: new Date("2026-09-30T15:00:00Z"), periodEnd: new Date("2026-10-31T15:00:00Z") })],
    });
    const [sub] = await d.repo.subscriptions.list({ customerId: "u1", provider: "toss" });
    expect(sub.anchorDay).toBe(1); // KST 10/1 00:00, not the UTC 30th
  });
});
