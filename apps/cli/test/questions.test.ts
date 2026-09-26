import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { QUESTIONS } from '../src/questions.js';
import { emptyConfig } from '../src/config.js';
import type { WizardConfig } from '../src/wizard-state.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const EDGE_CASES_PATH = path.resolve(__dirname, '../../../docs/EDGE_CASES.md');

// --- parse docs/EDGE_CASES.md for every P0 `policy.x.y` key -----------------------------------
//
// Table rows are `| ... | P0/P1/P2 |` with priority always the LAST cell. A row's policy key(s)
// live in backtick-fenced `policy.a.b_c` tokens ANYWHERE in that row (some are in the 정책 키
// column, some — e.g. B1's `policy.credits.bank_cap` — are only mentioned inline in the 선택지
// column). I1 is a documented shorthand: `policy.cs.auto_approve.max_amount_minor` · `max_credits`
// means both `...max_amount_minor` and `...max_credits` under `policy.cs.auto_approve`.
function parseP0PolicyKeys(doc: string): string[] {
  const keys = new Set<string>();
  for (const line of doc.split('\n')) {
    if (!line.startsWith('|') || !line.endsWith('|')) continue;
    const cells = line.split('|').slice(1, -1).map((c) => c.trim());
    if (cells.length < 2) continue;
    const priority = cells[cells.length - 1];
    if (priority !== 'P0') continue;
    for (const m of line.matchAll(/`policy\.[a-zA-Z0-9_.]+`/g)) {
      keys.add(m[0].slice(1, -1));
    }
  }
  // I1: `max_credits` sits beside `policy.cs.auto_approve.max_amount_minor` with no own "policy."
  // prefix (see docs/EDGE_CASES.md section I). Expand it explicitly rather than guessing from
  // bare-word backtick tokens generally (those are usually enum values, e.g. `banked`, `deny`).
  if (keys.has('policy.cs.auto_approve.max_amount_minor')) {
    keys.add('policy.cs.auto_approve.max_credits');
  }
  return [...keys];
}

/** `policy.credits.bank_cap` -> `credits.bankCap` (matches Question.policyPath format). */
function docKeyToPolicyPath(docKey: string): string {
  return docKey
    .split('.')
    .slice(1)
    .map((seg) => seg.replace(/_([a-z0-9])/g, (_m, c: string) => c.toUpperCase()))
    .join('.');
}

describe('QUESTIONS covers every P0 policy key from docs/EDGE_CASES.md', () => {
  const doc = readFileSync(EDGE_CASES_PATH, 'utf8');
  const p0Keys = parseP0PolicyKeys(doc);
  const questionPolicyPaths = new Set(QUESTIONS.filter((q) => q.policyPath).map((q) => q.policyPath));

  it('parsed at least one P0 policy key (sanity check the parser itself)', () => {
    expect(p0Keys.length).toBeGreaterThan(0);
  });

  it('has a question for every P0 policy key', () => {
    const missing = p0Keys
      .map((k) => ({ docKey: k, path: docKeyToPolicyPath(k) }))
      .filter(({ path: p }) => !questionPolicyPaths.has(p));
    expect(missing, `missing questions for: ${missing.map((m) => m.docKey).join(', ')}`).toEqual([]);
  });
});

describe('when() gating', () => {
  const base = () => emptyConfig() as WizardConfig;

  it('usage.overage / usage.lateReportWindowHours questions only fire with the usage model', () => {
    const withoutUsage = { ...base(), models: [] } as WizardConfig;
    const withUsage = { ...base(), models: ['usage'] } as WizardConfig;
    for (const id of ['usage_overage', 'usage_late_report_window_hours']) {
      const q = QUESTIONS.find((x) => x.id === id)!;
      expect(q.when?.(withoutUsage), id).toBe(false);
      expect(q.when?.(withUsage), id).toBe(true);
    }
  });

  it('usage.includedQuantity fires for either the usage model or the usage_quota good', () => {
    const q = QUESTIONS.find((x) => x.id === 'usage_included_quantity')!;
    expect(q.when?.({ ...base(), models: [], goods: [] } as WizardConfig)).toBe(false);
    expect(q.when?.({ ...base(), models: ['usage'], goods: [] } as WizardConfig)).toBe(true);
    expect(q.when?.({ ...base(), models: [], goods: ['usage_quota'] } as WizardConfig)).toBe(true);
  });

  it('usage.overageUnitPriceMinor only fires when overage=bill_overage AND usage model selected', () => {
    const q = QUESTIONS.find((x) => x.id === 'usage_overage_unit_price')!;
    const cfg = base();
    cfg.models = ['usage'];
    cfg.policy.usage.overage = 'hard_block';
    expect(q.when?.(cfg)).toBe(false);
    cfg.policy.usage.overage = 'bill_overage';
    expect(q.when?.(cfg)).toBe(true);
    cfg.models = [];
    expect(q.when?.(cfg)).toBe(false);
  });

  it('infra.scheduler question only fires with portone (not toss alone)', () => {
    const q = QUESTIONS.find((x) => x.id === 'infra_scheduler')!;
    expect(q.when?.({ ...base(), providers: [] } as WizardConfig)).toBe(false);
    expect(q.when?.({ ...base(), providers: ['toss'] } as WizardConfig)).toBe(false);
    expect(q.when?.({ ...base(), providers: ['stripe'] } as WizardConfig)).toBe(false);
    expect(q.when?.({ ...base(), providers: ['portone'] } as WizardConfig)).toBe(true);
    expect(q.when?.({ ...base(), providers: ['toss', 'portone'] } as WizardConfig)).toBe(true);
  });

  it('policy authority is always configured while only API key depends on reporting', () => {
    const off = base();
    off.cs.enabled = false;
    const on = base();
    on.cs.enabled = true;
    for (const id of [
      'cs_api_key',
      'cs_regrant_mode',
      'cs_auto_approve_max_amount',
      'cs_auto_approve_max_credits',
      'cs_fraud_refund_velocity',
    ]) {
      const q = QUESTIONS.find((x) => x.id === id)!;
      expect(q.when ? q.when(off) : true, id).toBe(id !== 'cs_api_key');
      expect(q.when ? q.when(on) : true, id).toBe(true);
    }
  });

  it('trial questions only fire when trialEnabled AND subscription model selected', () => {
    for (const id of ['trial_credits_on_convert', 'trial_credits_on_cancel', 'trial_abuse_guard']) {
      const q = QUESTIONS.find((x) => x.id === id)!;
      expect(q.when?.({ ...base(), models: ['subscription'], trialEnabled: false } as WizardConfig), id).toBe(false);
      expect(q.when?.({ ...base(), models: [], trialEnabled: true } as WizardConfig), id).toBe(false);
      expect(q.when?.({ ...base(), models: ['subscription'], trialEnabled: true } as WizardConfig), id).toBe(true);
    }
  });

  it('subscription-only questions (upgrade/downgrade/cancel/dunning) only fire with the subscription model', () => {
    for (const id of ['upgrade_mode', 'downgrade_mode', 'cancel_mode', 'dunning_grace_days', 'dunning_on_final_failure']) {
      const q = QUESTIONS.find((x) => x.id === id)!;
      expect(q.when?.({ ...base(), models: [] } as WizardConfig), id).toBe(false);
      expect(q.when?.({ ...base(), models: ['subscription'] } as WizardConfig), id).toBe(true);
    }
  });

  it('credits questions only fire when credits good is selected', () => {
    for (const id of ['credits_rollover', 'credits_consume_order', 'credits_negative_balance', 'credits_pools']) {
      const q = QUESTIONS.find((x) => x.id === id)!;
      expect(q.when?.({ ...base(), goods: [] } as WizardConfig), id).toBe(false);
      expect(q.when?.({ ...base(), goods: ['credits'] } as WizardConfig), id).toBe(true);
    }
  });
});
