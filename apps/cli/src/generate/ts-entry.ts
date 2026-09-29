// paykit/index.ts generator — composes ONLY the selected modules into createPaymentKit().
//
// Import names and function signatures below were verified against the actual built packages
// (packages/*/ts/src/index.ts) on 2026-09-09, not guessed from docs/ARCHITECTURE.md §3.5 alone.
// Notable real-world deviations from the ARCHITECTURE.md pseudo-signatures, kept in generated
// code comments too (see "계약 변경 제안" in the final report):
//   - lifecycle exports `dunning` and `scheduler` as namespace objects (`dunning.onGraceExpired`,
//     `scheduler.tick`), not flat `dunningOnGraceExpired`/`schedulerTick`.
//   - credits.expireDue takes a required `customerId` (per-customer), not a global batch call.
//   - usage.flushOutbox takes the whole `providers` map in one call, not one call per provider.
//   - lifecycle.scheduler.tick returns `{ charged: Subscription[], failed: Subscription[] }`
//     (arrays), not counts.
//   - webhook.receive takes the resolved `PaymentProvider` instance (not a provider name string)
//     and returns `eventId` (camelCase); webhook.process needs `clock` too.
//   - webhook.defaultHandlers takes duck-typed `lifecycle`/`credits`/`refund`/`cs` dep bags
//     (see packages/webhook/ts/src/handlers.ts) instead of importing those packages itself.
//   - refund.execute and cs.dispute/openCase/reconcile all require `ids: IdGen` in addition to
//     what ARCHITECTURE.md's short-form signature lists.
import type { PaykitConfig } from '../config.js';
import { hasReasonRules, supportTs } from './support.js';

function providerImportsTs(config: PaykitConfig): string {
  const lines: string[] = [];
  if (config.providers.includes('stripe')) lines.push(`import { StripeProvider } from 'boilpayment-sdk/stripe';`);
  if (config.providers.includes('polar')) lines.push(`import { PolarProvider } from 'boilpayment-sdk/polar';`);
  if (config.providers.includes('toss')) lines.push(`import { TossProvider } from 'boilpayment-sdk/toss';`);
  if (config.providers.includes('portone')) lines.push(`import { PortoneProvider } from 'boilpayment-sdk/portone';`);
  return lines.join('\n');
}

// EC:L1 — every provider constructor takes an optional `logger` (defaults to NoopLogger inside
// the provider itself if omitted here, but we always pass the one this app built so provider.request
// events actually reach it).
function providerConstructionTs(config: PaykitConfig): string {
  const lines: string[] = [];
  if (config.providers.includes('stripe')) {
    lines.push(`  providers.stripe = new StripeProvider({ secretKey: env.STRIPE_SECRET_KEY, webhookSecret: env.STRIPE_WEBHOOK_SECRET, previousWebhookSecrets: (env.STRIPE_WEBHOOK_PREVIOUS_SECRETS ?? '').split(',').map((v: string) => v.trim()).filter(Boolean), ...(env.STRIPE_API_BASE ? { apiBase: (() => { const u = new URL(env.STRIPE_API_BASE); return { host: u.hostname, port: u.port ? Number(u.port) : undefined, protocol: u.protocol.replace(':', '') as 'http' | 'https' }; })() } : {}), logger });`);
  }
  if (config.providers.includes('polar')) {
    lines.push(`  providers.polar = new PolarProvider({ accessToken: env.POLAR_ACCESS_TOKEN, webhookSecret: env.POLAR_WEBHOOK_SECRET, previousWebhookSecrets: (env.POLAR_WEBHOOK_PREVIOUS_SECRETS ?? '').split(',').map((v: string) => v.trim()).filter(Boolean), ...(env.POLAR_API_BASE ? { apiBase: env.POLAR_API_BASE } : {}), logger });`);
  }
  if (config.providers.includes('toss')) {
    // EC:E19 — no allowlist means every Toss webhook is refused at receipt (fail closed).
    lines.push(`  providers.toss = new TossProvider({ secretKey: env.TOSS_SECRET_KEY, clientKey: env.TOSS_CLIENT_KEY, allowedWebhookIps: (env.TOSS_WEBHOOK_ALLOWED_IPS ?? '').split(',').map((ip: string) => ip.trim()).filter(Boolean), ...(env.TOSS_API_BASE ? { apiBase: env.TOSS_API_BASE } : {}), logger });`);
  }
  if (config.providers.includes('portone')) {
    lines.push(`  providers.portone = new PortoneProvider({ apiSecret: env.PORTONE_API_SECRET, storeId: env.PORTONE_STORE_ID, webhookSecret: env.PORTONE_WEBHOOK_SECRET, scheduling: 'self', ...(env.PORTONE_API_BASE ? { apiBase: env.PORTONE_API_BASE } : {}), previousWebhookSecrets: (env.PORTONE_WEBHOOK_PREVIOUS_SECRETS ?? '').split(',').map((v: string) => v.trim()).filter(Boolean), logger });`);
  }
  return lines.join('\n');
}

/** The schema-postgres module names matching the .sql files this config copied (see migrations.ts). */
function migrationModules(config: PaykitConfig): string[] {
  const mods = ['core', 'webhook', 'refund'];
  if (config.goods.includes('credits')) mods.push('credits');
  if (config.models.includes('usage') || config.goods.includes('usage_quota')) mods.push('usage');
  mods.push('cs');
  return mods;
}

export function generateIndexTs(config: PaykitConfig): string {
  const hasCredits = config.goods.includes('credits');
  const hasSubscription = config.models.includes('subscription');
  const hasUsage = config.models.includes('usage') || config.goods.includes('usage_quota');
  // Toss has no native subscriptions and is always self-scheduled. Portone follows
  // EC:A43 — Toss and PortOne are both self-scheduled: our cron charges the billing key each period.
  const selfSchedulingProviders = config.providers.filter(
    (pr) => pr === 'toss' || pr === 'portone', // EC:A43 — PortOne renews through the kit's scheduler
  );
  const hasSelfScheduler = hasSubscription && selfSchedulingProviders.length > 0;
  const hasReservations = hasCredits && config.reservations === true; // EC:C10
  const hasReports = config.reports === true; // EC:I10

  const l: string[] = [];
  l.push(`// Generated by \`boilpayment init\`. This is your code now — edit freely.`);
  l.push(`// Wires only the modules you selected in the wizard. See ../POLICY.md for the policy this composes.`);
  l.push(`import type { Deps, Notifier, Payment, PaymentProvider, Plan, PlanPrice, ProviderName, Policy, Subscription, Logger } from 'boilpayment-sdk/core';`);
  l.push(`import { calculateAffiliateAccrual, money, resolvePolicy, NoopLogger, ConsoleLogger${hasSubscription && hasCredits ? ', INACTIVE_SUBSCRIPTION_STATUSES' : ''}${hasCredits || hasSubscription ? ', PaymentKitError' : ''} } from 'boilpayment-sdk/core';`);
  l.push(`import { verifySchema } from 'boilpayment-sdk/postgres';`);
  if (config.infra.logging === 'postgres') {
    l.push(`import { PostgresLogger, createPool } from 'boilpayment-sdk/postgres';`);
  }
  if (hasCredits) {
    l.push(`import { grantForPeriod, consume as consumeCredits, rolloverOnRenewal, clawback, expireDue, topup } from 'boilpayment-sdk/credits';`);
  }
  if (hasSubscription) {
    l.push(
      // EC:A1 A3 A5 A23 — upgrade/downgrade/cancel/reactivate aliased so this file can define its
      // own thin `upgrade`/`downgrade`/`cancel`/`reactivate` wrappers below (threading policy/
      // ledger/repo/clock/ids + resolving `provider` from `sub.provider`) without shadowing the
      // imported function.
      `import { upgrade as lifecycleUpgrade, downgrade as lifecycleDowngrade, cancel as lifecycleCancel, reactivate as lifecycleReactivate, convertTrial, onRenewalPaid, dunning, retryOnVersionConflict${hasSelfScheduler ? ', scheduler, startSubscription as lifecycleStartSubscription, resolveHeldAttempt as lifecycleResolveHeldAttempt, resumeParked as lifecycleResumeParked' : ''} } from 'boilpayment-sdk/lifecycle';`,
    );
  }
  l.push(`import { evaluate as evaluateRefund, execute as executeRefund, onExternalRefund } from 'boilpayment-sdk/refund';`);
  if (hasUsage) {
    l.push(`import { record as recordUsage, check as checkUsage, settleDuePeriods, flushOutbox } from 'boilpayment-sdk/usage';`);
  }
  if (hasReservations) {
    l.push(`import { reserve as reserveBudget, commit as commitReservation, release as releaseReservation, sweepReservations, listReservations } from 'boilpayment-sdk/usage';`);
  }
  l.push(`import { receive as receiveWebhook, process as processWebhook, defaultHandlers } from 'boilpayment-sdk/webhook';`);
  const notifyImports: string[] = [];
  if (config.infra.notify.email === 'resend') notifyImports.push('resend');
  if (config.infra.notify.email === 'smtp') notifyImports.push('smtp');
  if (config.infra.notify.slack) notifyImports.push('slack');
  if (notifyImports.length) l.push(`import { ${notifyImports.join(', ')} } from 'boilpayment-sdk/notify';`);
  if (hasReports) l.push(`import { settlementReport } from 'boilpayment-sdk/cs';`);
  l.push(`import { startCheckout, registerCompletedCheckout as registerCheckout, applyPurchasedGrant, buildPaymentLinkUrl as buildProviderPaymentLinkUrl, decodePaymentLinkReference, reconcile as reconcileCases, finishRefundCases, requestRefund, recoverMissingGrant, recoverMissingGrants, resolveTopupCredits, dispute, openCase, HttpLicenseReporter, NoopLicenseReporter } from 'boilpayment-sdk/cs';`);
  const providerImports = providerImportsTs(config);
  if (providerImports) l.push(providerImports);
  l.push('');

  l.push(`export interface PaymentKitEnv {`);
  l.push(`  DATABASE_URL: string;`);
  if (config.providers.includes('stripe')) { l.push(`  STRIPE_SECRET_KEY: string;`); l.push(`  STRIPE_WEBHOOK_SECRET: string;`); l.push(`  STRIPE_WEBHOOK_PREVIOUS_SECRETS?: string; // comma list, secrets being rotated out (EC:E20)`); l.push(`  STRIPE_API_BASE?: string; // local mock host (e.g. stripe-mock); empty = https://api.stripe.com`); }
  if (config.providers.includes('polar')) { l.push(`  POLAR_ACCESS_TOKEN: string;`); l.push(`  POLAR_WEBHOOK_SECRET: string;`); l.push(`  POLAR_WEBHOOK_PREVIOUS_SECRETS?: string; // comma list, secrets being rotated out (EC:E20)`); l.push(`  POLAR_API_BASE?: string; // local mock / sandbox host; empty = Polar production`); }
  if (config.providers.includes('toss')) { l.push(`  TOSS_SECRET_KEY: string;`); l.push(`  TOSS_CLIENT_KEY: string;`); l.push(`  TOSS_WEBHOOK_ALLOWED_IPS?: string; // comma list; empty refuses every Toss webhook (EC:E19)`); l.push(`  TOSS_API_BASE?: string; // local mock / staging host; empty = https://api.tosspayments.com`); }
  if (config.providers.includes('portone')) { l.push(`  PORTONE_API_SECRET: string;`); l.push(`  PORTONE_STORE_ID: string;`); l.push(`  PORTONE_WEBHOOK_SECRET: string;`); l.push(`  PORTONE_WEBHOOK_PREVIOUS_SECRETS?: string; // comma list, secrets being rotated out (EC:E20)`); l.push(`  PORTONE_API_BASE?: string; // local mock / sandbox host; empty = https://api.portone.io`); }
  if (config.infra.notify.email === 'resend') { l.push(`  RESEND_API_KEY: string;`); l.push(`  RESEND_FROM_EMAIL: string;`); l.push(`  RESEND_TO_EMAIL: string; // fallback recipient when a notification has no per-customer email`); }
  if (config.infra.notify.email === 'smtp') { l.push(`  SMTP_HOST: string; SMTP_PORT: string; SMTP_USER: string; SMTP_PASS: string; SMTP_FROM_EMAIL: string;`); l.push(`  SMTP_TO_EMAIL: string; // fallback recipient when a notification has no per-customer email`); }
  if (config.infra.notify.slack) l.push(`  SLACK_WEBHOOK_URL: string;`);
  l.push(`  /** CS SDK API 키 — docs/CS_SERVER.md. 비어 있으면 NoopLicenseReporter 로 폴백 (케이스 사용량이 서버에 보고되지 않음). */`);
  l.push(`  PAYKIT_API_KEY?: string;`);
  l.push(`  PAYKIT_API_BASE_URL?: string; // 기본값: HttpLicenseReporter 의 baseUrl 기본값 (docs/CS_SERVER.md)`);
  l.push(`}`);
  l.push('');

  l.push(`export interface PaymentKitDeps extends Omit<Deps, 'providers' | 'notifier' | 'policy'> {`);
  l.push(`  env: PaymentKitEnv;`);
  l.push(`  providers?: Partial<Record<ProviderName, PaymentProvider>>;`);
  l.push(`  notifier?: Notifier;`);
  l.push(`}`);
  l.push('');

  l.push(`function buildProviders(env: PaymentKitEnv, logger: Logger): Partial<Record<ProviderName, PaymentProvider>> {`);
  l.push(`  const providers: Partial<Record<ProviderName, PaymentProvider>> = {};`);
  const providerCtor = providerConstructionTs(config);
  if (providerCtor) l.push(providerCtor);
  l.push(`  return providers;`);
  l.push(`}`);
  l.push('');

  l.push(`/** EC:L1-L5 (docs/EDGE_CASES.md §L) — driven by infra.logging in paykit.config.json ('${config.infra.logging}' here). */`);
  l.push(`function buildLogger(env: PaymentKitEnv): Logger {`);
  if (config.infra.logging === 'postgres') {
    l.push(`  return new PostgresLogger(createPool(env.DATABASE_URL));`);
  } else if (config.infra.logging === 'console') {
    l.push(`  return new ConsoleLogger();`);
  } else {
    l.push(`  return new NoopLogger();`);
  }
  l.push(`}`);
  l.push('');

  l.push(`function buildNotifier(env: PaymentKitEnv): Notifier {`);
  if (notifyImports.length === 0) {
    l.push(`  return { send: async () => {} }; // 알림 없음 (no notify adapter selected)`);
  } else {
    l.push(`  const adapters: Notifier[] = [`);
    if (config.infra.notify.email === 'resend') l.push(`    resend({ apiKey: env.RESEND_API_KEY, from: env.RESEND_FROM_EMAIL, to: env.RESEND_TO_EMAIL }),`);
    if (config.infra.notify.email === 'smtp') l.push(`    smtp({ host: env.SMTP_HOST, port: Number(env.SMTP_PORT), auth: { user: env.SMTP_USER, pass: env.SMTP_PASS }, from: env.SMTP_FROM_EMAIL, to: env.SMTP_TO_EMAIL }),`);
    if (config.infra.notify.slack) l.push(`    slack({ webhookUrl: env.SLACK_WEBHOOK_URL }),`);
    l.push(`  ];`);
    l.push(`  return { send: async (n) => { await Promise.all(adapters.map((a) => a.send(n))); } };`);
  }
  l.push(`}`);
  l.push('');

  l.push(`/** Composes the selected modules per paykit.config.json. deps.env carries provider/notify secrets. */`);
  l.push(`export function createPaymentKit(config: typeof import('../paykit.config.json'), deps: PaymentKitDeps) {`);
  // paykit.config.json is plain JSON: every enum reads as `string`, so a direct cast to
  // Partial<Policy> stops overlapping as the Policy grows. resolvePolicy validates it at runtime.
  l.push(`  const policy: Policy = resolvePolicy(config.policy as unknown as Partial<Policy>);`);
  l.push(`  // EC:L1-L5 — deps.logger (if the caller already built one) wins; otherwise built from infra.logging.`);
  l.push(`  const logger: Logger = deps.logger ?? buildLogger(deps.env);`);
  l.push(`  const providers = deps.providers ?? buildProviders(deps.env, logger);`);
  l.push(`  const notifier = deps.notifier ?? buildNotifier(deps.env);`);
  l.push(`  const full: Deps = { ...deps, policy, providers, notifier, logger };`);
  l.push(`  const checkoutConfig = config.checkout ?? { registrationHoldHours: 24 };`);
  l.push(`  const configuredCommission: unknown = config.affiliate?.commission;`);
  l.push(`  const affiliateCommissionRule = typeof configuredCommission === 'object' && configuredCommission !== null`);
  l.push(`    && 'type' in configuredCommission && configuredCommission.type === 'fixed' && 'amountMinor' in configuredCommission && typeof configuredCommission.amountMinor === 'number'`);
  l.push(`    ? { type: 'fixed' as const, amountMinor: configuredCommission.amountMinor }`);
  l.push(`    : { type: 'rate' as const, rate: typeof configuredCommission === 'object' && configuredCommission !== null && 'rate' in configuredCommission && typeof configuredCommission.rate === 'number' ? configuredCommission.rate : 0 };`);
  l.push(`  const configuredRenewals: unknown = config.affiliate?.renewals;`);
  l.push(`  const affiliateRenewals: 'first_only' | 'include' = configuredRenewals === 'include' ? 'include' : 'first_only';`);
  l.push(`  const commissionForPayment = async (payment: Payment) => {`);
  l.push(`    const amountMinor = full.affiliateCommission ? await full.affiliateCommission(payment) : calculateAffiliateAccrual(payment.amount, affiliateCommissionRule).amountMinor;`);
  l.push(`    return money(amountMinor, payment.amount.currency);`);
  l.push(`  };`);
  l.push(`  const accrueAffiliatePayment = async (payment: Payment) => {`);
  l.push(`    if (!payment.affiliateId) return;`);
  l.push(`    const amount = await commissionForPayment(payment);`);
  l.push(`    if (amount.amountMinor <= 0) return;`);
  l.push(`    await full.repo.affiliateCommissions.append({ id: \`affiliate-accrual:\${payment.id}\`, kind: 'accrual', affiliateId: payment.affiliateId, paymentId: payment.id, refundId: null, relatedAccrualId: null, amount, idempotencyKey: \`affiliate:\${payment.id}:accrual\`, createdAt: full.clock.now() });`);
  l.push(`  };`);
  l.push('');

  l.push(`  // EC:I5 — reports billable CS case transitions to Schift's license server (docs/CS_SERVER.md).`);
  l.push(`  // Falls back to NoopLicenseReporter (never reports, never throws) when no API key is set.`);
  if (config.cs.enabled) {
    l.push(`  const licenseReporter = deps.env.PAYKIT_API_KEY`);
    l.push(`    ? new HttpLicenseReporter({ apiKey: deps.env.PAYKIT_API_KEY, baseUrl: deps.env.PAYKIT_API_BASE_URL })`);
    l.push(`    : new NoopLicenseReporter();`);
  } else {
    l.push(`  const licenseReporter = new NoopLicenseReporter();`);
  }
  l.push('');
  l.push(`  // Adapts cs.openCase to the small case-opener shapes refund.onExternalRefund/execute expect,`);
  l.push(`  // so refund/execute stay decoupled from importing boilpayment-sdk/cs directly (EC:D8/D12).`);
  l.push(`  const caseOpener = {`);
  l.push(`    async openReconcileMismatchCase(input: { customerId: string | null; referenceId: string; reason: string }) {`);
  l.push(`      // EC:E24 — no local customer: tell a person (a case needs a customer row).`);
  l.push(`      if (!input.customerId || !(await full.repo.customers.get(input.customerId))) {`);
  l.push(`        await notifier.send({ type: 'cs.needs_human', customerId: null, payload: { kind: 'reconcile_mismatch', referenceId: input.referenceId, reason: input.reason } });`);
  l.push(`        return;`);
  l.push(`      }`);
  l.push(`      await openCase({ customerId: input.customerId, kind: 'reconcile_mismatch', referenceId: input.referenceId, policy, repo: full.repo, clock: full.clock, ids: full.ids });`);
  l.push(`    },`);
  l.push(`    async openRefundFailedCase(input: { customerId: string; referenceId: string; reason: string }) {`);
  l.push(`      await openCase({ customerId: input.customerId, kind: 'refund_failed', referenceId: input.referenceId, policy, repo: full.repo, clock: full.clock, ids: full.ids });`);
  l.push(`    },`);
  l.push(`  };`);
  l.push('');

  l.push(`  const handlers = defaultHandlers({`);
  l.push(`    policy, ledger: full.ledger, repo: full.repo, notifier, clock: full.clock, ids: full.ids,`);
  l.push(`    decodeLinkReference: decodePaymentLinkReference,`);
  l.push(`    affiliateRenewals, commissionForPayment,`);
  l.push(`    openLinkMismatchCase: async ({ payment, reason }) => {`);
  l.push(`      const id = \`payment-link-mismatch:\${payment.id}\`;`);
  l.push(`      if (await full.repo.csCases.get(id)) return;`);
  l.push(`      const now = full.clock.now();`);
  l.push(`      await full.repo.csCases.put({ id, customerId: payment.customerId, kind: 'reconcile_mismatch', status: 'needs_human', referenceId: payment.id, policySnapshot: structuredClone(policy), decision: { reason }, churnReason: null, churnText: null, openedAt: now, resolvedAt: null, escalatedAt: now });`);
  l.push(`      await notifier.send({ type: 'cs.needs_human', customerId: payment.customerId || null, payload: { caseId: id, paymentId: payment.id, reason } });`);
  l.push(`    },`);
  if (hasCredits || hasSubscription) {
    l.push(`    grantLinkPayment: async ({ payment, plan, subscription }) => {`);
    if (hasSubscription) {
      l.push(`      if (subscription) { await onRenewalPaid({ sub: subscription, payment, policy, ledger: full.ledger, repo: full.repo, clock: full.clock }); return; }`);
    }
    if (hasCredits) {
      l.push(`      await topup({ customerId: payment.customerId, payment, credits: plan.creditsPerPeriod, policy, ledger: full.ledger, repo: full.repo, clock: full.clock });`);
      l.push(`      return;`);
    }
    l.push(`      throw new PaymentKitError('payment-link entitlement is unavailable for this plan', 'payment_link_grant_unavailable');`);
    l.push(`    },`);
  } else {
    l.push(`    grantLinkPayment: null,`);
  }
  if (hasSubscription) {
    l.push(`    lifecycle: { onRenewalPaid, dunning: { onPaymentFailed: dunning.onPaymentFailed } },`);
  } else {
    l.push(`    lifecycle: null,`);
  }
  if (hasCredits) {
    l.push(`    credits: { topup: (input) => applyPurchasedGrant({ customerId: input.customerId, paymentId: input.payment.id, ...supportDeps, grants: { topup, grantForPeriod } }) },
    resolveTopupCredits: (payment) => resolveTopupCredits({ payment, repo: full.repo }),`);
  } else {
    l.push(`    credits: null,`);
  }
  l.push(`    refund: { onExternalRefund: async (input: { event: Parameters<typeof onExternalRefund>[0]['event']; ledger: typeof full.ledger; repo: typeof full.repo }) => {`);
  l.push(`      const result = await onExternalRefund({ event: input.event, ledger: input.ledger, repo: input.repo, clock: full.clock, ids: full.ids, cs: caseOpener });`);
  l.push(`      await finishRefundCases({ repo: full.repo, clock: full.clock, notifier, reporter: licenseReporter });`);
  l.push(`      return result;`);
  l.push(`    } },`);
  l.push(`    cs: { dispute: (input: Omit<Parameters<typeof dispute>[0], 'clock' | 'ids' | 'reporter'>) => dispute({ ...input, clock: full.clock, ids: full.ids, reporter: licenseReporter }) },`);
  l.push(`  });`);
  l.push('');

  l.push(`  /** Capture the configured sale before redirecting to the provider. */`);
  l.push(`  const checkout = (input: Pick<Parameters<typeof startCheckout>[0], 'customerId' | 'planId' | 'provider' | 'currency' | 'requestId' | 'successUrl' | 'cancelUrl' | 'allowDiscountCodes' | 'presetDiscountCode' | 'affiliateId'>) => startCheckout({ ...input, ...supportDeps });`);
  l.push(`  async function registerCompletedCheckout(input: Pick<Parameters<typeof registerCheckout>[0], 'customerId' | 'checkoutId' | 'paymentRef' | 'subscriptionRef'>) {`);
  l.push(`    const payment = await registerCheckout({ ...input, ...supportDeps });`);
  if (hasCredits || hasSubscription) {
    l.push(`    if (await full.repo.operations.get(\`checkout-payment-held:\${payment.id}\`)) {`);
    if (hasCredits) {
      l.push(`      await applyPurchasedGrant({ customerId: input.customerId, paymentId: payment.id, ...supportDeps, grants: { topup, grantForPeriod } });`);
      l.push(`      await accrueAffiliatePayment(payment);`);
    } else {
      l.push(`      if (payment.kind === 'subscription') await accrueAffiliatePayment(payment);`);
    }
    l.push(`    }`);
  }
  l.push(`    return payment;`);
  l.push(`  }`);
  l.push(`  const buildPaymentLinkUrl = (input: { provider: ProviderName; linkUrl: string; customerId: string; affiliateId?: string | null }) => buildProviderPaymentLinkUrl(input);`);
  l.push(`  const affiliate = {`);
  l.push(`    list: (input: { affiliateId: string; paymentId?: string; kind?: 'accrual' | 'reversal' }) => full.repo.affiliateCommissions.list(input),`);
  l.push(`    sum: async (input: { affiliateId: string; currency?: string }): Promise<number | Record<string, number>> => {`);
  l.push(`      const rows = await full.repo.affiliateCommissions.list({ affiliateId: input.affiliateId });`);
  l.push(`      const totals: Record<string, number> = {};`);
  l.push(`      for (const row of rows) totals[row.amount.currency] = (totals[row.amount.currency] ?? 0) + (row.kind === 'accrual' ? row.amount.amountMinor : -row.amount.amountMinor);`);
  l.push(`      return input.currency ? (totals[input.currency] ?? 0) : totals;`);
  l.push(`    },`);
  l.push(`  };`);
  if (hasSubscription) {
    l.push(`  /** EC:A1 A2 A8 J1-J5 — mid-cycle plan upgrade (immediate proration or scheduled next-period, per policy). Resolves \`provider\` from \`sub.provider\` unless overridden. */`);
    l.push(`  async function upgrade(input: Omit<Parameters<typeof lifecycleUpgrade>[0], 'policy' | 'ledger' | 'repo' | 'clock' | 'ids' | 'provider'> & { provider?: PaymentProvider }) {`);
    l.push(`    const provider = input.provider ?? providers[input.sub.provider];`);
    l.push(`    if (!provider) throw new Error(\`provider not configured: \${input.sub.provider}\`);`);
    l.push(`    return lifecycleUpgrade({ ...input, provider, policy, ledger: full.ledger, repo: full.repo, clock: full.clock, ids: full.ids });`);
    l.push(`  }`);
    l.push('');
    if (hasSelfScheduler) {
      l.push(`  /** EC:A65 — start a ${selfSchedulingProviders.join('/')} subscription from a billing key (INTEGRATION.md §2). */`);
      l.push(`  async function startSubscription(input: Omit<Parameters<typeof lifecycleStartSubscription>[0], 'policy' | 'ledger' | 'repo' | 'clock' | 'provider' | 'notifier'> & { provider?: ProviderName }) {`);
      l.push(`    const { provider: name, ...rest } = input;`);
      l.push(`    const provider = providers[name ?? '${selfSchedulingProviders[0]}'];`);
      l.push(`    if (!provider) throw new Error(\`provider not configured: \${name}\`);`);
      l.push(`    return lifecycleStartSubscription({ ...rest, provider, policy, ledger: full.ledger, repo: full.repo, clock: full.clock, notifier });`);
      l.push(`  }`);
      l.push('');
      l.push(`  /** EC:A53 A58 — decide a renewal attempt held for review: settle, void or close (INTEGRATION.md). */`);
      l.push(`  async function resolveHeldAttempt(input: { paymentId: string; decision: 'settle' | 'void' | 'close'; actor: string; note?: string }) {`);
      l.push(`    const row = await full.repo.payments.get(input.paymentId);`);
      l.push(`    const provider = row ? providers[row.provider] : undefined;`);
      l.push(`    if (!provider) throw new PaymentKitError('payment is not an attempt held for review', 'attempt_not_held', { paymentId: input.paymentId });`);
      l.push(`    return lifecycleResolveHeldAttempt({ ...input, provider, policy, ledger: full.ledger, repo: full.repo, clock: full.clock, notifier });`);
      l.push(`  }`);
      l.push('');
      l.push(`  /** EC:A54 — resume a subscription parked by missedPeriods: 'needs_human_only'. */`);
      l.push(`  const resumeParked = (input: { subscriptionId: string; actor: string }) => lifecycleResumeParked({ ...input, policy, repo: full.repo, clock: full.clock, notifier });`);
      l.push('');
    }
    l.push(`  /** EC:A3 A4 J1-J5 — downgrade, optionally clawing back the credit surplus immediately (per policy). */`);
    l.push(`  async function downgrade(input: Omit<Parameters<typeof lifecycleDowngrade>[0], 'policy' | 'ledger' | 'repo' | 'clock' | 'ids' | 'provider'> & { provider?: PaymentProvider }) {`);
    l.push(`    const provider = input.provider ?? providers[input.sub.provider];`);
    l.push(`    if (!provider) throw new Error(\`provider not configured: \${input.sub.provider}\`);`);
    l.push(`    return lifecycleDowngrade({ ...input, provider, policy, ledger: full.ledger, repo: full.repo, clock: full.clock, ids: full.ids });`);
    l.push(`  }`);
    l.push('');
    l.push(`  /** EC:A5 A6 A10 I4 J1-J5 — cancel now or at period end; resolves outstanding credits per policy. */`);
    l.push(`  async function cancel(input: Omit<Parameters<typeof lifecycleCancel>[0], 'policy' | 'ledger' | 'repo' | 'clock' | 'provider'> & { provider?: PaymentProvider }) {`);
    l.push(`    const provider = input.provider ?? providers[input.sub.provider];`);
    l.push(`    if (!provider) throw new Error(\`provider not configured: \${input.sub.provider}\`);`);
    l.push(`    return lifecycleCancel({ ...input, provider, policy, ledger: full.ledger, repo: full.repo, clock: full.clock });`);
    l.push(`  }`);
    l.push('');
    l.push(`  /** EC:A23 — undo an EC:A5 end-of-period cancel while the subscription is still active (the mirror image of cancel's credit revoke). */`);
    l.push(`  async function reactivate(input: Omit<Parameters<typeof lifecycleReactivate>[0], 'policy' | 'ledger' | 'repo' | 'clock' | 'provider'> & { provider?: PaymentProvider }) {`);
    l.push(`    const provider = input.provider ?? providers[input.sub.provider];`);
    l.push(`    if (!provider) throw new Error(\`provider not configured: \${input.sub.provider}\`);`);
    l.push(`    return lifecycleReactivate({ ...input, provider, policy, ledger: full.ledger, repo: full.repo, clock: full.clock });`);
    l.push(`  }`);
    l.push('');
  }
  if (hasSubscription) {
    l.push(`  /** EC:C11 A72 — the customer's current subscription (a live one first, then the latest), for entitlement checks the kit owns. */`);
    l.push(`  async function currentSubscription(customerId: string): Promise<Subscription | undefined> {`);
    l.push(`    const subs = await full.repo.subscriptions.list({ customerId });`);
    l.push(`    const live = (s: Subscription) => (s.status === 'active' || s.status === 'trialing' || s.status === 'past_due' ? 0 : 1);`);
    l.push(`    return subs.sort((a, b) => live(a) - live(b) || b.createdAt.getTime() - a.createdAt.getTime())[0];`);
    l.push(`  }`);
  }
  if (hasCredits) {
    l.push(`  /** EC:A66 — a customer frozen by an open dispute, or banned after losing one, spends nothing. */`);
    l.push(`  async function assertCustomerCanSpend(customerId: string) {`);
    l.push(`    const customer = await full.repo.customers.get(customerId);`);
    l.push(`    if (customer && customer.status !== 'active') throw new PaymentKitError(\`customer \${customerId} is \${customer.status}\`, \`customer_\${customer.status}\`);`);
    l.push(`  }`);
    l.push(`  /** EC:B3 B4 B5 B14 — atomic consume against the ledger. */`);
    l.push(`  async function consume(input: Omit<Parameters<typeof consumeCredits>[0], 'policy' | 'ledger' | 'clock'>) {`);
    l.push(`    await assertCustomerCanSpend(input.customerId);`);
    if (hasSubscription) {
      l.push(`    // EC:C11 — an unpaid subscription (paused, incomplete) spends nothing; canceled/expired keep bought credits.`);
      l.push(`    const sub = await currentSubscription(input.customerId);`);
      l.push(`    if (sub && INACTIVE_SUBSCRIPTION_STATUSES.includes(sub.status)) throw new PaymentKitError(\`subscription \${sub.id} is \${sub.status}\`, 'subscription_inactive');`);
      l.push(`    // EC:A44 — policy.dunning.usageDuringGrace = 'block' stops spending while a renewal is unpaid.`);
      l.push(`    if (sub && sub.status === 'past_due' && policy.dunning.usageDuringGrace === 'block') throw new PaymentKitError(\`subscription \${sub.id} is past due\`, 'grace_usage_blocked');`);
    }
    l.push(`    return consumeCredits({ ...input, policy, ledger: full.ledger, clock: full.clock });`);
    l.push(`  }`);
  } else {
    l.push(`  async function consume(): Promise<never> {`);
    l.push(`    throw new Error('credits not selected in paykit.config.json (goods)');`);
    l.push(`  }`);
  }
  l.push('');
  if (hasUsage) {
    l.push(`  /** EC:C2 C3 — usage event ingestion + EC:C1 C5 C6 quota/overage check. */`);
    l.push(`  async function record(input: Omit<Parameters<typeof recordUsage>[0], 'policy' | 'repo' | 'clock' | 'ids' | 'provider' | 'plan'>) {`);
    l.push(`    return recordUsage({ ...input, provider: providers[input.sub.provider], plan: await full.repo.plans.get(input.sub.planId), policy, repo: full.repo, clock: full.clock, ids: full.ids });`);
    l.push(`  }`);
    l.push(`  async function checkQuota(input: Omit<Parameters<typeof checkUsage>[0], 'policy' | 'repo' | 'ledger' | 'clock'>) {`);
    l.push(`    return checkUsage({ ...input, policy, repo: full.repo, ledger: full.ledger, clock: full.clock });`);
    l.push(`  }`);
  }
  l.push('');
  if (hasReservations) {
    l.push(`  /** EC:C10 — budget for long-running work: reserve before it starts, commit what it used on success, release on failure. */`);
    l.push(`  const reservations = {`);
    if (hasSubscription) {
      l.push(`    // EC:C11 — the subscription is passed so a paused/incomplete/canceled/expired one is refused.`);
      l.push(`    reserve: async (input: { customerId: string; jobId: string; amount: number; subscriptionId?: string }) => {`);
      l.push(`      await assertCustomerCanSpend(input.customerId);`);
      l.push(`      const sub = input.subscriptionId ? await full.repo.subscriptions.get(input.subscriptionId) : await currentSubscription(input.customerId);`);
      l.push(`      // EC:A44 — only the customer's own subscription counts; grace blocks spending when the policy says so.`);
      l.push(`      if (sub && sub.customerId !== input.customerId) throw new PaymentKitError('subscription does not belong to this customer', 'subscription_not_owned');`);
      l.push(`      if (sub && sub.status === 'past_due' && policy.dunning.usageDuringGrace === 'block') throw new PaymentKitError(\`subscription \${sub.id} is past due\`, 'grace_usage_blocked');`);
      l.push(`      return reserveBudget({ customerId: input.customerId, jobId: input.jobId, amount: input.amount, sub: sub ?? undefined, policy, ledger: full.ledger, clock: full.clock });`);
      l.push(`    },`);
    } else {
      l.push(`    reserve: async (input: { customerId: string; jobId: string; amount: number }) => { await assertCustomerCanSpend(input.customerId); return reserveBudget({ ...input, policy, ledger: full.ledger, clock: full.clock }); },`);
    }
    l.push(`    commit: (input: { customerId: string; jobId: string; amount: number }) => commitReservation({ ...input, policy, ledger: full.ledger, clock: full.clock }),`);
    l.push(`    release: (input: { customerId: string; jobId: string }) => releaseReservation({ ...input, policy, ledger: full.ledger, clock: full.clock }),`);
    l.push(`    list: (customerId: string) => listReservations({ customerId, ledger: full.ledger }),`);
    l.push(`  };`);
    l.push('');
  }
  if (hasReports) {
    l.push(`  /** EC:I10 — read-only totals for [from, to): payments, succeeded refunds, net per currency, credit movements. */`);
    l.push(`  const reports = { settlement: (input: { from: Date; to: Date }) => settlementReport({ ...input, repo: full.repo, ledger: full.ledger }) };`);
    l.push('');
  }
  l.push(`  /** EC:D* — policy-driven refund evaluation + execution. */`);
  l.push(`  async function refund(input: Omit<Parameters<typeof evaluateRefund>[0], 'policy' | 'ledger' | 'repo' | 'clock'>, extra?: Record<string, unknown>) {`);
  l.push(`    const decision = await evaluateRefund({ ...input, policy, ledger: full.ledger, repo: full.repo, clock: full.clock });`);
  l.push(`    return {`);
  l.push(`      decision,`);
  l.push(`      // caller resolves the provider (payment.provider) and passes it in — refund/execute stays provider-agnostic.`);
  l.push(`      execute: (provider: PaymentProvider) => executeRefund({ decision, provider, ledger: full.ledger, repo: full.repo, clock: full.clock, ids: full.ids, extra, cs: caseOpener }),`);
  l.push(`    };`);
  l.push(`  }`);
  l.push('');
  l.push(`  /**`);
  l.push(`   * EC:E3 E4 E5 E13 — webhook receipt is provider-scoped. Route \`${config.infra.webhookPath}/:provider\``);
  l.push(`   * to this (INTEGRATION.md §3), or pass { provider } explicitly when only`);
  l.push(`   * one provider is configured.`);
  l.push(`   */`);
  l.push(`  async function handleWebhook(rawBody: string, headers: Record<string, string>, opts?: { provider?: ProviderName; /** EC:E18 — req.socket.remoteAddress, never a header */ remoteAddress?: string }) {`);
  l.push(`    const configured = Object.keys(providers) as ProviderName[];`);
  l.push(`    const providerName = opts?.provider ?? (configured.length === 1 ? configured[0] : undefined);`);
  l.push(`    if (!providerName) throw new Error('multiple providers configured — pass { provider } to handleWebhook');`);
  l.push(`    const provider = providers[providerName];`);
  l.push(`    if (!provider) throw new Error(\`provider not configured: \${providerName}\`);`);
  l.push(`    const received = await receiveWebhook({ provider, headers, rawBody, remoteAddress: opts?.remoteAddress, repo: full.repo, clock: full.clock });`);
  l.push(`    if (received.status === 200 && received.eventId) await processWebhook({ eventId: received.eventId, providers, handlers, repo: full.repo, clock: full.clock });`);
  l.push(`    return received;`);
  l.push(`  }`);
  l.push('');

  l.push(supportTs(hasCredits, hasReasonRules(config)));
  l.push(`  const cron = {`);
  if (hasCredits) {
    l.push(`    /** credits.expireDue is per-customer (see NAMING ASSUMPTION note at the top of this file) — sweep all customers. */`);
    l.push(`    expireDue: async () => {`);
    l.push(`      const customers = await full.repo.customers.list();`);
    l.push(`      for (const customer of customers) await expireDue({ ledger: full.ledger, clock: full.clock, customerId: customer.id });`);
    l.push(`    },`);
  } else {
    l.push(`    expireDue: async () => {},`);
  }
  if (hasSubscription) {
    l.push(`    dunningSweep: async () => {`);
    l.push(`      // No cast here on purpose: this object's keys become SQL column names in
      // PostgresRepo.list, so a typo must fail the typecheck, not the query.
      const due = await full.repo.subscriptions.list({ status: 'past_due' });`);
    l.push(`      const now = full.clock.now();`);
    l.push(`      for (const stale of due) {`);
    l.push(`        // EC:K1 — the list read and the write inside onGraceExpired are far apart; another`);
    l.push(`        // writer (webhook, scheduler) can bump the row in between. Re-read per attempt.`);
    l.push(`        await retryOnVersionConflict(async () => {`);
    l.push(`          const sub = await full.repo.subscriptions.get(stale.id);`);
    l.push(`          if (!sub) return;`);
    l.push(`          if (sub.graceUntil && sub.graceUntil <= now) await dunning.onGraceExpired({ sub, policy, ledger: full.ledger, repo: full.repo, notifier, clock: full.clock });`);
    l.push(`        });`);
    l.push(`      }`);
    l.push(`    },`);
  } else {
    l.push(`    dunningSweep: async () => {},`);
  }
  if (hasUsage) {
    l.push(`    closePeriods: () => settleDuePeriods({ policy, repo: full.repo, ledger: full.ledger, providers, clock: full.clock }),`);
    l.push(`    flushOutbox: () => flushOutbox({ repo: full.repo, providers, clock: full.clock }),`);
  } else {
    l.push(`    closePeriods: async () => {},`);
    l.push(`    flushOutbox: async () => {},`);
  }
  if (hasSelfScheduler) {
    l.push(`    schedulerTick: async () => {`);
    l.push(`      // self-scheduling providers: ${selfSchedulingProviders.join(', ')} (EC:A43: Toss and PortOne always self).`);
    l.push(`      const selfSchedulingProviders: ProviderName[] = [${selfSchedulingProviders.map((p) => `'${p}'`).join(', ')}];`);
    l.push(`      const charged: Subscription[] = [];`);
    l.push(`      const failed: Subscription[] = [];`);
    l.push(`      const errors: Array<{ subscriptionId: string; code: string; message: string }> = [];`);
    l.push(`      for (const name of selfSchedulingProviders) {`);
    l.push(`        const provider = providers[name];`);
    l.push(`        if (!provider) continue;`);
    l.push(`        const result = await scheduler.tick({ provider, repo: full.repo, policy, ledger: full.ledger, clock: full.clock, ids: full.ids, notifier });`);
    l.push(`        charged.push(...result.charged);`);
    l.push(`        failed.push(...result.failed);`);
    l.push(`        errors.push(...result.errors);`);
    l.push(`        // EC:A34 — due dunning retries charge through the same per-period attempt records as the tick.`);
    l.push(`        for (const item of await dunning.retryDue({ repo: full.repo, clock: full.clock })) {`);
    l.push(`          const sub = await full.repo.subscriptions.get((item.payload as { subscriptionId: string }).subscriptionId);`);
    l.push(`          if (!sub || sub.provider !== name) continue;`);
    l.push(`          try {`);
    l.push(`            const retry = await dunning.runRetry({ item, provider, repo: full.repo, ledger: full.ledger, policy, notifier, clock: full.clock });`);
    l.push(`            if (retry.outcome === 'recovered' && retry.sub) charged.push(retry.sub);`);
    l.push(`          } catch (err) {`);
    l.push(`            errors.push({ subscriptionId: sub.id, code: (err as { code?: string }).code ?? 'dunning_retry_error', message: err instanceof Error ? err.message : String(err) });`);
    l.push(`          }`);
    l.push(`        }`);
    l.push(`      }`);
    l.push(`      // EC:A36 — never dropped: every unresolved or failed renewal is logged and returned.`);
    l.push(`      for (const e of errors) await logger.log({ level: 'error', event: 'scheduler.error', ...e });`);
    l.push(`      return { charged, failed, errors };`);
    l.push(`    },`);
  } else {
    l.push(`    schedulerTick: async () => ({ charged: [] as Subscription[], failed: [] as Subscription[], errors: [] as Array<{ subscriptionId: string; code: string; message: string }> }),`);
  }
  if (hasReservations) l.push(`    sweepReservations: () => sweepReservations({ repo: full.repo, ledger: full.ledger, clock: full.clock }),`);
  l.push(`    reconcile: async (since: Date) => {`);
  if (hasCredits) l.push(`      const recovered = await recoverMissingGrants({ ...supportDeps, grants: { topup, grantForPeriod }, since });`);
  else l.push(`      const recovered: unknown[] = [];`);
  l.push(`      const cases = await reconcileCases({ policy, providers, ledger: full.ledger, repo: full.repo, clock: full.clock, ids: full.ids, since, registrationHoldHours: checkoutConfig.registrationHoldHours });`);
  l.push(`      return [...recovered, ...cases];`);
  l.push(`    },`);
  l.push(`  };`);
  l.push('');
  l.push(`  // licenseReporter is available for separately composed metered CS workflows.`);
  l.push(`  // Call this at boot, before serving traffic: it fails loudly when the database is behind`);
  l.push(`  // this build instead of letting the first query die on a missing column in production.`);
  l.push(`  const verifyDbSchema = () => verifySchema({ connectionString: deps.env.DATABASE_URL, modules: ${JSON.stringify(migrationModules(config))} });`);
  l.push(`  async function initialize(opts: { verifySchema?: boolean } = {}) {`);
  l.push(`    if (opts.verifySchema !== false) await verifyDbSchema();`);
  l.push(`    for (const plan of config.plans) {`);
  l.push(`      const interval = plan.interval;`);
  l.push(`      if (interval !== null && interval !== 'month' && interval !== 'year') throw new Error('invalid plan interval');`);
  l.push(`      const existing = await full.repo.plans.get(plan.id);`);
  l.push(`      const configuredPrices: PlanPrice[] = plan.prices;`);
  l.push(`      const prices = configuredPrices.map((price) => {`);
  l.push(`        const stored = existing?.prices.find((candidate) => candidate.currency === price.currency);`);
  l.push(`        return { ...price, providerPriceRefs: { ...(stored?.providerPriceRefs ?? {}), ...(price.providerPriceRefs ?? {}) } };`);
  l.push(`      });`);
  l.push(`      await full.repo.plans.put({ ...plan, interval, prices });`);
  l.push(`    }`);
  l.push(`  }`);
  l.push('');
  l.push(`  return { handleWebhook, consume${hasUsage ? ', record, checkQuota' : ''}, checkout, buildPaymentLinkUrl, affiliate${hasSubscription ? ', upgrade, downgrade, cancel, reactivate' : ''}${hasSelfScheduler ? ', startSubscription, resolveHeldAttempt, resumeParked' : ''}, registerCompletedCheckout, initialize, refund, support${hasReservations ? ', reservations' : ''}${hasReports ? ', reports' : ''}, cron, verifySchema: verifyDbSchema, deps: full, licenseReporter };`);
  l.push(`}`);
  l.push('');

  return l.join('\n');
}
