// Shared test helpers — not a *.test.ts file itself (vitest only picks up test/spec files).
import { QUESTIONS } from '../src/questions.js';
import { emptyConfig } from '../src/config.js';
import { setPath } from '../src/util/path.js';
import type { WizardConfig } from '../src/wizard-state.js';
import type { PlanConfig } from '../src/config.js';

/**
 * Mirrors wizard.ts's `runWizard({ yes: true, ... })` non-interactive path: walk QUESTIONS in
 * order, skip when `q.when` says no, otherwise write `overridesById[q.id] ?? q.default` at the
 * question's real path (policy.<policyPath> or <configPath>). Unlike `runWizard`, this lets a
 * test answer ANY question by id (runWizard's `overrides` only covers a few top-level fields)
 * and never touches @clack/prompts. Uses the real `q.when` predicates and the real `setPath`,
 * so gating logic under test is the actual production logic, not a re-implementation of it.
 */
export function buildConfig(overridesById: Record<string, unknown> = {}): WizardConfig {
  const config = emptyConfig() as WizardConfig;
  for (const q of QUESTIONS) {
    if (q.when && !q.when(config)) continue;
    const path = q.policyPath ? `policy.${q.policyPath}` : q.configPath!;
    let value = Object.prototype.hasOwnProperty.call(overridesById, q.id) ? overridesById[q.id] : q.default;
    // Mirror wizard.ts exactly: BOTH its paths run the answer through `q.parse` when there is one.
    // Skipping it here made this double looser than the real thing, and the generate tests spent a
    // long time passing against a config the wizard cannot produce — `dunning.retryIntervalHours`
    // stayed the string "24,72,120" instead of [24, 72, 120], which resolvePolicy rejects outright.
    // A typecheck and an import never call resolvePolicy, so nothing noticed.
    if (q.parse && (typeof value === 'string' || typeof value === 'number')) value = q.parse(String(value));
    setPath(config as unknown as Record<string, unknown>, path, value);
  }
  return config;
}

export function samplePlan(overrides: Partial<PlanConfig> = {}): PlanConfig {
  return {
    id: 'default',
    name: 'Pro',
    interval: 'month',
    creditsPerPeriod: 1000,
    usageIncluded: 0,
    trialDays: 0,
    prices: [{ currency: 'USD', amountMinor: 1999 }],
    ...overrides,
  };
}

/** Every wizard question answered, every gated question triggered — for generator tests that
 *  want maximal generated-code coverage in one shot (ts typecheck, py import, POLICY.md, env). */
export const KITCHEN_SINK_ANSWERS: Record<string, unknown> = {
  providers: ['stripe', 'polar', 'toss', 'portone'],
  models: ['subscription', 'topup', 'usage'],
  goods: ['credits', 'usage_quota'],
  credits_rollover: 'banked',
  downgrade_mode: 'immediate_clawback',
  trial_enabled: true,
  refund_method: 'min_of_both',
  refund_advanced: true,
  usage_overage: 'bill_overage',
  cs_enabled: true,
  cs_api_key: 'pk_live_test_key',
  languages: ['ts', 'py'],
  infra_notify_email: 'resend',
  infra_notify_slack: true,
  infra_scheduler: 'self',
};

export function kitchenSinkConfig(): WizardConfig {
  const config = buildConfig(KITCHEN_SINK_ANSWERS);
  config.plans = [samplePlan()];
  return config;
}
