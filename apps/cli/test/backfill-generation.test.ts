// EC:M1 — the situation questions and what they generate.
//
// Three things are pinned here: (1) answering "no existing customers" produces exactly what the kit
// produced before the question existed (no `situation` key, no backfill files); (2) the situation
// answers become the defaults of later questions; (3) the generated paykit/backfill.{ts,py}
// actually run — against in-memory stores, a provider double for Stripe, twice (idempotent).
import { afterAll, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runWizard } from "../src/wizard.js";
import { QUESTIONS } from "../src/questions.js";
import { toPaykitConfig } from "../src/wizard-state.js";
import { generateAll } from "../src/generate/index.js";
import { backfillColumns } from "../src/generate/backfill.js";
import { buildConfig, samplePlan } from "./helpers.js";

const ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../..",
);
const dirs: string[] = [];
afterAll(async () => {
  await Promise.all(
    dirs.map((d) => fs.rm(d, { recursive: true, force: true })),
  );
});
async function tmp(prefix: string): Promise<string> {
  const d = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  dirs.push(d);
  return d;
}

describe("situation questions", () => {
  it("come first, and only the first is asked when there are no existing customers", () => {
    expect(QUESTIONS.slice(0, 3).map((q) => q.id)).toEqual([
      "situation_existing",
      "situation_providers",
      "situation_has",
    ]);
    const c = buildConfig();
    expect(c.situation).toEqual({ existingCustomers: false });
    expect(toPaykitConfig(c)).not.toHaveProperty("situation");
  });

  it("--yes stores nothing new", async () => {
    const config = toPaykitConfig(
      await runWizard({ yes: true, existingRaw: null }),
    );
    expect(config).not.toHaveProperty("situation");
    expect(config.providers).toEqual(["stripe"]);
  });

  it("existing customers set the defaults of provider and model questions, which are still asked", async () => {
    const c = await runWizard({
      yes: true,
      existingRaw: {
        situation: {
          existingCustomers: true,
          providers: ["toss", "polar"],
          has: ["credits"],
        },
      },
    });
    expect(c.providers).toEqual(["toss", "polar"]);
    expect(c.models).toEqual(["topup"]);
    expect(c.goods).toEqual(["credits"]);
    expect(toPaykitConfig(c).situation).toEqual({
      existingCustomers: true,
      providers: ["toss", "polar"],
      has: ["credits"],
    });
    const explicit = await runWizard({
      yes: true,
      existingRaw: {
        situation: {
          existingCustomers: true,
          providers: ["toss"],
          has: ["subscriptions"],
        },
        providers: ["stripe"],
      },
    });
    expect(explicit.providers).toEqual(["stripe"]);
  });

  it("the CSV template carries only the columns the answers need", () => {
    const cols = (providers: string[], has: string[]) =>
      backfillColumns({
        ...buildConfig(),
        situation: {
          existingCustomers: true,
          providers: providers as never,
          has: has as never,
        },
      });
    expect(cols(["stripe"], ["subscriptions"])).toEqual([
      "customer_id",
      "email",
      "provider",
      "customer_ref",
      "subscription_ref",
      "plan_id",
    ]);
    expect(cols(["toss"], ["subscriptions", "credits"])).toEqual([
      "customer_id",
      "email",
      "provider",
      "customer_ref",
      "plan_id",
      "billing_key",
      "period_start",
      "period_end",
      "credits",
      "credits_expire_at",
    ]);
    expect(cols(["stripe", "toss"], ["credits"])).toEqual([
      "customer_id",
      "email",
      "provider",
      "customer_ref",
      "credits",
      "credits_expire_at",
    ]);
  });
});

function existingConfig() {
  const c = buildConfig({
    situation_existing: true,
    situation_providers: ["stripe", "toss"],
    situation_has: ["subscriptions", "credits"],
    languages: ["ts", "py"],
  });
  c.plans = [samplePlan({ id: "pro" })];
  return toPaykitConfig(c);
}

const CSV = `customer_id,email,provider,customer_ref,subscription_ref,plan_id,billing_key,period_start,period_end,credits,credits_expire_at
u1,u1@example.com,stripe,cus_1,sub_1,pro,,,,50,
u2,,toss,ck_2,,pro,bk_2,2026-02-01T00:00:00Z,2026-03-01T00:00:00Z,,
u3,,stripe,cus_1,sub_1,missing_plan,,,,,
`;

describe("generated backfill scripts", () => {
  it("are generated only with existing customers", async () => {
    const none = await tmp("paykit-bf-none-");
    await generateAll(
      toPaykitConfig(buildConfig({ languages: ["ts", "py"] })),
      none,
    );
    expect(
      (await fs.readdir(path.join(none, "paykit"))).filter((f) =>
        f.startsWith("backfill"),
      ),
    ).toEqual([]);
    expect(
      await fs.readFile(path.join(none, "INTEGRATION.md"), "utf8"),
    ).not.toContain("기존 고객 들이기");
    const yes = await tmp("paykit-bf-yes-");
    await generateAll(existingConfig(), yes);
    expect(
      (await fs.readdir(path.join(yes, "paykit")))
        .filter((f) => f.startsWith("backfill"))
        .sort(),
    ).toEqual(["backfill.example.csv", "backfill.py", "backfill.ts"]);
    expect(
      await fs.readFile(path.join(yes, "INTEGRATION.md"), "utf8"),
    ).toContain("## 7. 기존 고객 들이기");
  });

  it("ts: typechecks and imports rows twice without duplicating anything", async () => {
    const dir = await tmp("paykit-bf-ts-");
    await fs.writeFile(
      path.join(dir, "package.json"),
      JSON.stringify({ type: "module" }),
    );
    await generateAll(existingConfig(), dir);
    await fs.mkdir(path.join(dir, "node_modules"), { recursive: true });
    await fs.symlink(
      path.join(ROOT, "packages/sdk/ts"),
      path.join(dir, "node_modules/boilpayment-sdk"),
      "dir",
    );
    await fs.writeFile(
      path.join(dir, "tsconfig.json"),
      JSON.stringify({
        compilerOptions: {
          target: "ES2022",
          module: "NodeNext",
          moduleResolution: "NodeNext",
          strict: true,
          resolveJsonModule: true,
          esModuleInterop: true,
          skipLibCheck: true,
          noEmit: true,
          types: ["node"],
          typeRoots: [
            path.join(ROOT, "node_modules/@types"),
            path.join(ROOT, "apps/cli/node_modules/@types"),
          ],
        },
        include: ["paykit/backfill.ts"],
      }),
    );
    const tsc = spawnSync(
      path.join(ROOT, "apps/cli/node_modules/.bin/tsc"),
      ["-p", "tsconfig.json"],
      { cwd: dir, encoding: "utf8" },
    );
    expect(tsc.status, `tsc:\n${tsc.stdout}\n${tsc.stderr}`).toBe(0);
    await fs.writeFile(
      path.join(dir, "run.ts"),
      `
import { runBackfill } from './paykit/backfill.js';
import { InMemoryRepo, InMemoryLedger, FixedClock, SequentialIdGen, NoopLogger } from 'boilpayment-sdk/core';
const clock = new FixedClock(new Date('2026-02-15T00:00:00Z'));
const ids = new SequentialIdGen('t');
const period = { start: new Date('2026-02-01T00:00:00Z'), end: new Date('2026-03-01T00:00:00Z') };
const stripe = {
  name: 'stripe',
  capabilities: () => ({ nativeSubscriptions: true, partialRefund: true, meters: true, scheduling: 'provider', webhookSignature: true }),
  getSubscription: async (ref) => ({ id: ref, customerId: 'cus_1', planId: '', provider: 'stripe', providerRef: ref, status: 'active', currentPeriod: period, anchorDay: 1, cancelAtPeriodEnd: false, graceUntil: null, billingKey: null, scheduledPlanId: null, version: 0, createdAt: clock.now() }),
};
const toss = { name: 'toss', capabilities: () => ({ nativeSubscriptions: false, partialRefund: true, meters: false, scheduling: 'self', webhookSignature: false }) };
const repo = new InMemoryRepo();
const ledger = new InMemoryLedger(ids, clock);
const deps = { repo, ledger, clock, ids, logger: new NoopLogger(), env: { DATABASE_URL: '' }, providers: { stripe, toss } };
const csv = ${JSON.stringify(CSV)};
const first = await runBackfill(csv, deps, { verifySchema: false });
const second = await runBackfill(csv, deps, { verifySchema: false });
const pick = (r) => r.results.map((x) => [x.status, x.reason, x.customer, x.subscription, x.credits].join(':'));
console.log(JSON.stringify({ first: pick(first), second: pick(second), subs: (await repo.subscriptions.list()).length,
  u1: (await ledger.balance('u1', 'paid', clock.now())).available }));
`,
    );
    const res = spawnSync(
      path.join(ROOT, "apps/cli/node_modules/.bin/tsx"),
      ["run.ts"],
      { cwd: dir, encoding: "utf8" },
    );
    expect(res.status, `ts run:\n${res.stdout}\n${res.stderr}`).toBe(0);
    expect(JSON.parse(res.stdout.trim().split("\n").pop()!)).toEqual(EXPECTED);
  }, 120_000);

  it("py: imports the same rows with the same outcome", async () => {
    const dir = await tmp("paykit-bf-py-");
    await generateAll(existingConfig(), dir);
    await fs.writeFile(
      path.join(dir, "run.py"),
      `
import asyncio, json
from datetime import UTC, datetime
from boilpayment.core import Deps, FixedClock, InMemoryLedger, InMemoryRepo, NoopLogger, Period, ProviderCapabilities, SequentialIdGen, Subscription
from paykit.backfill import run_backfill

clock = FixedClock(datetime(2026, 2, 15, tzinfo=UTC))
ids = SequentialIdGen("t")
period = Period(start=datetime(2026, 2, 1, tzinfo=UTC), end=datetime(2026, 3, 1, tzinfo=UTC))

class Stripe:
    name = "stripe"
    def capabilities(self):
        return ProviderCapabilities(native_subscriptions=True, partial_refund=True, meters=True, scheduling="provider", webhook_signature=True)
    async def get_subscription(self, ref):
        return Subscription(id=ref, customer_id="cus_1", plan_id="", provider="stripe", provider_ref=ref, status="active", current_period=period,
                            anchor_day=1, cancel_at_period_end=False, grace_until=None, billing_key=None, scheduled_plan_id=None, created_at=clock.now())

class Toss:
    name = "toss"
    def capabilities(self):
        return ProviderCapabilities(native_subscriptions=False, partial_refund=True, meters=False, scheduling="self", webhook_signature=False)

async def main():
    repo, ledger = InMemoryRepo(), InMemoryLedger(ids, clock)
    deps = Deps(clock=clock, ids=ids, repo=repo, ledger=ledger, notifier=None, providers={}, policy=None, logger=NoopLogger())
    csv = ${JSON.stringify(CSV)}
    kw = {"verify_schema_first": False, "providers_override": {"stripe": Stripe(), "toss": Toss()}}
    first = await run_backfill(csv, deps, {"DATABASE_URL": ""}, **kw)
    second = await run_backfill(csv, deps, {"DATABASE_URL": ""}, **kw)
    pick = lambda r: [":".join(str(v) if v is not None else "" for v in (x.status, x.reason, x.customer, x.subscription, x.credits)) for x in r.results]
    print(json.dumps({"first": pick(first), "second": pick(second), "subs": len(await repo.subscriptions.list()),
                      "u1": (await ledger.balance("u1", "paid", clock.now())).available}))

asyncio.run(main())
`,
    );
    const res = spawnSync(path.join(ROOT, ".venv/bin/python"), ["run.py"], {
      cwd: dir,
      encoding: "utf8",
    });
    expect(res.status, `py run:\n${res.stdout}\n${res.stderr}`).toBe(0);
    expect(JSON.parse(res.stdout.trim().split("\n").pop()!)).toEqual(EXPECTED);
  }, 120_000);
});

const EXPECTED = {
  first: [
    "ok::created:created:created",
    "ok::created:created:none",
    "error:unknown_plan:none:none:none",
  ],
  second: [
    "ok::skipped:skipped:skipped",
    "ok::skipped:skipped:none",
    "error:unknown_plan:none:none:none",
  ],
  subs: 2,
  u1: 50,
};
