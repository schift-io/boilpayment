// Defaults = bold values in docs/EDGE_CASES.md. Keep in sync with core/py policy.py
import { Policy, PolicyValidationError } from './types.js';

export const DEFAULT_POLICY: Policy = {
  period: { timezone: 'UTC', monthEndAnchor: 'clamp_keep_original_day' },
  proration: { denominator: 'actual_days_in_period' },
  credits: {
    rollover: 'none', bankCap: null, bankReset: 'on_renewal', consumeOrder: 'expiring_first',
    negativeBalance: 'block', negativeFloor: 0, pools: 'separate', topupExpiryDays: null, grantLagBehavior: 'reject',
    expiryNoticeDays: null, negativeOffset: 'offset_next_grant',
    expiryDays: { promo: null, trial: null, manual: null, regrant: null },
  },
  upgrade: { mode: 'immediate_prorate_reset_anchor', creditDelta: 'full_delta' },
  downgrade: { mode: 'end_of_period', clawbackShortfall: 'clamp_to_zero' },
  cancel: { mode: 'end_of_period', credits: 'keep_until_period_end' },
  intervalChange: { mode: 'treat_as_upgrade' },
  trial: { creditsOnConvert: 'grant_full', creditsOnCancel: 'revoke', abuseGuard: 'one_per_customer' },
  pause: { mode: 'unsupported' },
  dunning: {
    graceDays: 7, usageDuringGrace: 'allow', grantDuringGrace: 'defer_until_paid',
    onFinalFailure: 'revoke_unpaid_period', onRecovery: 'regrant_current_period', preExpiryNoticeDays: 7,
    retryAttempts: 3, retryIntervalHours: [24, 72, 120],
  },
  refund: {
    noQuestionsDays: 7, method: 'unused_credits', overuseBehavior: 'deny', rounding: 'floor_credits',
    revokeShortfall: 'clamp_and_reduce_refund', feeBearer: 'merchant', maxPerCustomerPerYear: 2,
    annualMethod: 'same_as_monthly', annualDenyAfterDays: null,
    reasons: { technicalFailure: 'rules', dissatisfied: 'rules', userError: 'rules' },
  },
  usage: { overage: 'hard_block', overageUnitPriceMinor: null, lateReportWindowHours: 48, includedQuantity: 0, reservationTtlMinutes: 60, creditConversion: null },
  dispute: { onOpen: 'freeze_customer', onLost: 'revoke_and_ban', evidenceDueDays: 7 },
  cashReceipt: { mode: 'off', defaultType: 'personal', cancelOnRefund: true },
  cs: { regrant: { mode: 'auto' }, autoApprove: { maxAmountMinor: 50_000, maxCredits: 10_000 }, fraud: { refundVelocity: 2, windowDays: 30 } },
  subscription: { multiplePerCustomer: 'deny', missedPeriods: 'skip_and_notify' },
  retention: { operationDays: 7, auditLogDays: 90 },
};

type DeepPartial<T> = { [K in keyof T]?: T[K] extends object ? DeepPartial<T[K]> : T[K] };

function deepMerge<T>(base: T, patch: DeepPartial<T> | undefined): T {
  if (!patch) return base;
  const out: Record<string, unknown> = { ...(base as Record<string, unknown>) };
  for (const [k, v] of Object.entries(patch as Record<string, unknown>)) {
    const b = (base as Record<string, unknown>)[k];
    out[k] = v !== null && typeof v === 'object' && !Array.isArray(v) && b !== null && typeof b === 'object'
      ? deepMerge(b, v as DeepPartial<object>)
      : v;
  }
  return out as T;
}

/** Merge a partial policy (e.g. from paykit.config.json) over defaults and validate enums. */
export function resolvePolicy(patch?: DeepPartial<Policy>): Policy {
  return validatePolicy(structuredClone(deepMerge(DEFAULT_POLICY, patch)));
}

/** Enum/shape validation. Throws PolicyValidationError listing every invalid path. */
export function validatePolicy(p: unknown): Policy {
  const errors: string[] = [];
  const walk = (base: unknown, val: unknown, path: string) => {
    if (base === null || typeof base !== 'object') return;
    if (val === null || typeof val !== 'object' || Array.isArray(val)) { errors.push(`${path}: expected object`); return; }
    for (const key of Object.keys(val)) {
      if (!Object.hasOwn(base, key)) errors.push(`${path ? `${path}.` : ''}${key}: unknown key`);
    }
    for (const k of Object.keys(base as object)) {
      const bv = (base as Record<string, unknown>)[k];
      const vv = (val as Record<string, unknown>)[k];
      const here = path ? `${path}.${k}` : k;
      if (vv === undefined) { errors.push(`${here}: missing`); continue; }
      if (Array.isArray(bv)) {
        // EC:A24 — an array field is a VALUE: check the element type, never the length. The default's
        // length is not a contract (`retryIntervalHours: [24]` is legal and repeats its last value).
        if (!Array.isArray(vv)) { errors.push(`${here}: expected array`); continue; }
        if (vv.some((x) => !Number.isSafeInteger(x) || x < 1)) errors.push(`${here}: expected positive integer[]`);
        continue;
      }
      if (bv !== null && typeof bv === 'object') walk(bv, vv, here);
      else if (typeof bv === 'string' && typeof vv !== 'string') errors.push(`${here}: expected string`);
      else if (typeof bv === 'boolean' && typeof vv !== 'boolean') errors.push(`${here}: expected boolean`);
      else if (here === 'usage.creditConversion') {
        if (vv !== null) walk({ unit: '', creditsPerUnit: 0 }, vv, here);
      } else if (typeof bv === 'number' || bv === null) {
        if (bv === null && vv === null) continue;
        if (typeof vv !== 'number' || !Number.isSafeInteger(vv)) { errors.push(`${here}: expected integer`); continue; }
        if (here === 'credits.negativeFloor') {
          if (vv > 0) errors.push(`${here}: must be <= 0`);
        } else if (here !== 'credits.bankCap' && here !== 'credits.expiryNoticeDays') {
          const minimum = here === 'cs.fraud.windowDays' || here.startsWith('retention.') || here.startsWith('credits.expiryDays.') || here === 'usage.reservationTtlMinutes' ? 1 : 0;
          if (vv < minimum) errors.push(`${here}: must be >= ${minimum}`);
        }
      }
    }
  };
  walk(DEFAULT_POLICY, p, '');
  const pol = p as Policy;
  const enumCheck = (path: string, v: unknown, allowed: readonly string[]) => { if (!allowed.includes(v as string)) errors.push(`${path}: '${String(v)}' not in [${allowed.join(', ')}]`); };
  if (!errors.length) {
    enumCheck('period.monthEndAnchor', pol.period.monthEndAnchor, ['clamp_keep_original_day', 'clamp_permanently']);
    enumCheck('proration.denominator', pol.proration.denominator, ['actual_days_in_period', 'fixed_30']);
    enumCheck('credits.rollover', pol.credits.rollover, ['none', 'banked', 'full']);
    enumCheck('credits.bankReset', pol.credits.bankReset, ['on_renewal', 'never', 'on_cancel']);
    enumCheck('credits.consumeOrder', pol.credits.consumeOrder, ['expiring_first', 'promo_first_then_expiring', 'paid_first']);
    enumCheck('credits.negativeBalance', pol.credits.negativeBalance, ['block', 'allow_to_floor', 'allow_unbounded']);
    enumCheck('credits.pools', pol.credits.pools, ['separate', 'merged']);
    enumCheck('credits.grantLagBehavior', pol.credits.grantLagBehavior, ['reject', 'optimistic_hold']);
    enumCheck('upgrade.mode', pol.upgrade.mode, ['immediate_prorate_reset_anchor', 'immediate_prorate_keep_anchor', 'next_period']);
    enumCheck('upgrade.creditDelta', pol.upgrade.creditDelta, ['full_delta', 'prorated_delta']);
    enumCheck('downgrade.mode', pol.downgrade.mode, ['end_of_period', 'immediate_keep', 'immediate_clawback']);
    enumCheck('downgrade.clawbackShortfall', pol.downgrade.clawbackShortfall, ['clamp_to_zero', 'allow_negative', 'deny_downgrade']);
    enumCheck('cancel.mode', pol.cancel.mode, ['end_of_period', 'immediate']);
    enumCheck('cancel.credits', pol.cancel.credits, ['keep_until_period_end', 'keep_forever', 'revoke_immediately']);
    enumCheck('intervalChange.mode', pol.intervalChange.mode, ['treat_as_upgrade', 'next_period']);
    enumCheck('trial.creditsOnConvert', pol.trial.creditsOnConvert, ['grant_full', 'grant_full_keep_trial', 'no_grant_until_next_period']);
    enumCheck('trial.creditsOnCancel', pol.trial.creditsOnCancel, ['revoke', 'keep']);
    enumCheck('trial.abuseGuard', pol.trial.abuseGuard, ['one_per_customer', 'none']);
    enumCheck('pause.mode', pol.pause.mode, ['unsupported', 'freeze_credits', 'keep_running']);
    enumCheck('dunning.usageDuringGrace', pol.dunning.usageDuringGrace, ['allow', 'block', 'allow_existing_only']);
    enumCheck('dunning.grantDuringGrace', pol.dunning.grantDuringGrace, ['defer_until_paid', 'grant_anyway']);
    enumCheck('dunning.onFinalFailure', pol.dunning.onFinalFailure, ['revoke_unpaid_period', 'revoke_all', 'keep']);
    enumCheck('dunning.onRecovery', pol.dunning.onRecovery, ['regrant_current_period', 'regrant_all_missed', 'no_regrant']);
    enumCheck('refund.method', pol.refund.method, ['unused_credits', 'time_prorated', 'min_of_both', 'deny']);
    enumCheck('refund.overuseBehavior', pol.refund.overuseBehavior, ['deny', 'refund_time_prorated_anyway']);
    enumCheck('refund.rounding', pol.refund.rounding, ['floor_credits', 'ceil_credits', 'round_credits']);
    enumCheck('refund.revokeShortfall', pol.refund.revokeShortfall, ['clamp_and_reduce_refund', 'clamp_to_zero', 'allow_negative']);
    enumCheck('refund.feeBearer', pol.refund.feeBearer, ['merchant', 'customer']);
    enumCheck('refund.annualMethod', pol.refund.annualMethod, ['same_as_monthly', 'deny_after_days']);
    enumCheck('usage.overage', pol.usage.overage, ['hard_block', 'soft_cap_notify', 'bill_overage']);
    enumCheck('refund.reasons.technicalFailure', pol.refund.reasons.technicalFailure, ['rules', 'full']);
    enumCheck('refund.reasons.dissatisfied', pol.refund.reasons.dissatisfied, ['rules', 'evidence_required', 'needs_human']);
    enumCheck('refund.reasons.userError', pol.refund.reasons.userError, ['rules', 'deny']);
    enumCheck('dispute.onOpen', pol.dispute.onOpen, ['freeze_customer', 'revoke_disputed_grant', 'none']);
    enumCheck('dispute.onLost', pol.dispute.onLost, ['revoke_and_ban', 'revoke_only']);
    enumCheck('credits.negativeOffset', pol.credits.negativeOffset, ['offset_next_grant', 'never']);
    if (pol.dunning.retryAttempts < 0) errors.push('dunning.retryAttempts: must be >= 0');
    if (pol.dunning.retryAttempts > 0 && pol.dunning.retryIntervalHours.length === 0) errors.push('dunning.retryIntervalHours: required when retryAttempts > 0');
    if (pol.retention.operationDays < 1) errors.push('retention.operationDays: must be >= 1');
    enumCheck('cashReceipt.mode', pol.cashReceipt.mode, ['off', 'manual', 'auto']);
    enumCheck('cashReceipt.defaultType', pol.cashReceipt.defaultType, ['personal', 'business']);
    enumCheck('cs.regrant.mode', pol.cs.regrant.mode, ['auto', 'manual_approve', 'off']);
    enumCheck('subscription.multiplePerCustomer', pol.subscription.multiplePerCustomer, ['deny', 'allow_separate_pools', 'allow_merged_pool']);
    enumCheck('subscription.missedPeriods', pol.subscription.missedPeriods, ['skip_and_notify', 'needs_human_only']);
    if (pol.credits.rollover === 'banked' && pol.credits.bankCap === null) errors.push('credits.bankCap: required when rollover=banked');
    if (pol.usage.overage === 'bill_overage' && pol.usage.overageUnitPriceMinor === null) errors.push('usage.overageUnitPriceMinor: required when overage=bill_overage');
    if (pol.refund.annualMethod === 'deny_after_days' && pol.refund.annualDenyAfterDays === null) errors.push('refund.annualDenyAfterDays: required when annualMethod=deny_after_days');
    if (pol.dunning.graceDays < 0) errors.push('dunning.graceDays: must be >= 0');
    if (pol.refund.noQuestionsDays < 0) errors.push('refund.noQuestionsDays: must be >= 0');
  }
  if (errors.length) throw new PolicyValidationError(`invalid policy: ${errors.join('; ')}`, errors);
  return pol;
}
