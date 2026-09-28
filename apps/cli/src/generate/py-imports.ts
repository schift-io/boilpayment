// The import block of paykit/index.py (split out of py-entry.ts to keep each file under 500 lines).
// Same selection logic as generateIndexPy: only the modules the wizard selected are imported.
import type { PaykitConfig } from '../config.js';
import { hasReasonRules } from './support.js';
import { extrasImportsPy } from './py-extras.js';

function providerImportsPy(config: PaykitConfig): string[] {
  const lines: string[] = [];
  if (config.providers.includes('stripe')) lines.push(`from boilpayment.stripe import StripeProvider`);
  if (config.providers.includes('polar')) lines.push(`from boilpayment.polar import PolarProvider`);
  if (config.providers.includes('toss')) lines.push(`from boilpayment.toss import TossProvider, TossProviderConfig`);
  if (config.providers.includes('portone')) lines.push(`from boilpayment.portone import PortoneProvider, PortoneProviderConfig`);
  return lines;
}

export function importsPy(config: PaykitConfig): string[] {
  const hasCredits = config.goods.includes('credits');
  const hasSubscription = config.models.includes('subscription');
  const hasReservations = hasCredits && config.reservations === true; // EC:C10
  const hasReports = config.reports === true; // EC:I10
  const hasUsage = config.models.includes('usage') || config.goods.includes('usage_quota');
  const hasSelfScheduler = hasSubscription && config.providers.some((pr) => pr === 'toss' || pr === 'portone'); // EC:A43
  const l: string[] = [];
  l.push(`from __future__ import annotations`);
  l.push('');
  l.push(`from typing import Any`);
  l.push('');
  l.push(`from boilpayment.core import Clock, ConsoleLogger, Deps, LedgerStore, Logger, Money, NoopLogger, Notification, Notifier, Payment, ${hasCredits || hasSelfScheduler ? 'PaymentKitError, ' : ''}PaymentProvider, Period, Plan, PlanPrice, Policy, Repo, Subscription, resolve_policy`);
  l.push(`from boilpayment.postgres import verify_schema`);
  if (config.infra.logging === 'postgres') {
    l.push(`from boilpayment.postgres import PostgresLogger`);
  }
  if (hasCredits) {
    l.push(`from boilpayment.credits import (`);
    l.push(`    ConsumeCreditsInput,
    GrantForPeriodInput,
    GrantResult,`);
    l.push(`    ExpireDueInput,`);
    l.push(`    TopupInput,`);
    l.push(`    clawback,  # available for app-level use (see ../POLICY.md); not auto-wired — needs case-specific amounts`);
    l.push(`    consume as consume_credits,`);
    l.push(`    expire_due,`);
    l.push(`    grant_for_period,  # ditto`);
    l.push(`    rollover_on_renewal,  # ditto`);
    l.push(`    topup,`);
    l.push(`)`);
  }
  if (hasSubscription) {
    // EC:A1 A3 A5 A23 — upgrade/downgrade/cancel/reactivate aliased so this file can define its own
    // thin upgrade/downgrade/cancel/reactivate wrappers below (threading policy/ledger/repo/clock/
    // ids + resolving `provider` from `sub.provider`) without shadowing the imported function in the
    // same local scope.
    l.push(`from boilpayment.lifecycle import (`);
    l.push(`    CancelInput,`);
    l.push(`    DowngradeInput,`);
    l.push(`    OnRenewalPaidInput,`);
    l.push(`    ReactivateInput,`);
    l.push(`    UpgradeInput,`);
    l.push(`    cancel as lifecycle_cancel,`);
    l.push(`    convert_trial,  # available for app-level use; not auto-wired`);
    l.push(`    downgrade as lifecycle_downgrade,`);
    l.push(`    dunning,`);
    l.push(`    on_renewal_paid,`);
    l.push(`    reactivate as lifecycle_reactivate,`);
    l.push(`    retry_on_version_conflict,`);
    l.push(`    upgrade as lifecycle_upgrade,`);
    if (hasSelfScheduler) {
      l.push(`    scheduler,`);
      l.push(`    StartSubscriptionInput,`);
      l.push(`    start_subscription as lifecycle_start_subscription,`);
      l.push(`    resolve_held_attempt as lifecycle_resolve_held_attempt,`);
      l.push(`    resume_parked as lifecycle_resume_parked,`);
    }
    l.push(`)`);
  }
  l.push(`from boilpayment.refund import (`);
  l.push(`    EvaluateInput,`);
  l.push(`    ExecuteInput,`);
  l.push(`    OnExternalRefundInput,`);
  if (hasReasonRules(config)) l.push(`    RefundReasonInput,`);
  l.push(`    evaluate as evaluate_refund,`);
  l.push(`    execute as execute_refund,`);
  l.push(`    on_external_refund,`);
  l.push(`)`);
  if (hasUsage) {
    l.push(`from boilpayment.usage import UsageEventInput, check as check_usage, settle_due_periods, flush_outbox, record as record_usage`);
  }
  l.push(...extrasImportsPy(hasReservations, hasReports));
  l.push(`from boilpayment.webhook import default_handlers, process as process_webhook, receive as receive_webhook`);
  const notifyImports: string[] = [];
  if (config.infra.notify.email === 'resend') notifyImports.push('resend');
  if (config.infra.notify.email === 'smtp') notifyImports.push('smtp');
  if (config.infra.notify.slack) notifyImports.push('slack');
  if (notifyImports.length) l.push(`from boilpayment.notify import ${notifyImports.join(', ')}`);
  l.push(`from boilpayment.cs import (`);
  l.push(`    DisputeInput,`);
  l.push(`    HttpLicenseReporter,`);
  l.push(`    NoopLicenseReporter,`);
  l.push(`    OpenCaseInput,`);
  l.push(`    StartCheckoutInput,
  RegisterCompletedCheckoutInput,
  ApplyPurchasedGrantInput,
  FinishRefundCasesInput,
  RequestRefundInput,
  RecoverMissingGrantInput,
  RecoverMissingGrantsInput,`);
  l.push(`    dispute,`);
  l.push(`    open_case,`);
  l.push(`    start_checkout,
  register_completed_checkout as register_checkout,
  apply_purchased_grant,
  finish_refund_cases,
  request_refund,
  recover_missing_grant,
  recover_missing_grants,
  resolve_topup_credits,`);
  l.push(`)`);
  for (const line of providerImportsPy(config)) l.push(line);
  return l;
}
