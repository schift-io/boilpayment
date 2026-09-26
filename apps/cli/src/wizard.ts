// Runs the question list (questions.ts) either interactively (@clack/prompts) or
// non-interactively (--yes / --config), producing a WizardConfig.
import * as p from '@clack/prompts';
import pc from 'picocolors';
import { QUESTIONS, type Question } from './questions.js';
import { getPath, setPath } from './util/path.js';
import { emptyConfig, type PaykitConfig } from './config.js';
import type { WizardConfig } from './wizard-state.js';

export interface WizardOptions {
  /** Non-interactive: apply every default, never prompt. */
  yes: boolean;
  /** Raw (unresolved) JSON from an existing paykit.config.json, if --config was passed and the file exists. */
  existingRaw: Record<string, unknown> | null;
  /** CLI flag overrides, applied before prompting/defaulting and never re-asked. */
  overrides?: Partial<Pick<PaykitConfig, 'providers' | 'models' | 'languages' | 'goods'>> & {
    /** `--cs` — shallow-merged over emptyConfig().cs (e.g. { enabled: true }), other cs.* keys keep their default. */
    cs?: Partial<PaykitConfig['cs']>;
  };
}

const GROUP_TITLES: Record<string, string> = {
  provider: '1. Provider 선택',
  model: '2. 결제 모델',
  goods: '3. 재화',
  period: '4. 주기 · 타임존',
  credits: '5. 크레딧',
  upgrade: '6. 업그레이드',
  downgrade: '7. 다운그레이드',
  cancel: '8. 취소',
  trial: '9. 트라이얼',
  dunning: '10. 갱신 실패',
  refund: '11. 환불',
  usage: '12. 이용량',
  dispute: '13. 분쟁',
  cs: '14. CS 자동화',
  infra: '15. 인프라',
};

function fullPath(q: Question): string {
  return q.policyPath ? `policy.${q.policyPath}` : q.configPath!;
}

function deepMerge(base: unknown, patch: unknown): unknown {
  if (patch === null || patch === undefined) return base;
  if (Array.isArray(patch)) return patch;
  if (typeof patch !== 'object') return patch;
  if (base === null || typeof base !== 'object' || Array.isArray(base)) return patch;
  const out: Record<string, unknown> = { ...(base as Record<string, unknown>) };
  for (const [k, v] of Object.entries(patch as Record<string, unknown>)) {
    out[k] = deepMerge((base as Record<string, unknown>)[k], v);
  }
  return out;
}

function isMissing(existingRaw: Record<string, unknown> | null, path: string): boolean {
  if (!existingRaw) return true;
  return getPath(existingRaw, path) === undefined;
}

async function promptOne(q: Question): Promise<unknown> {
  switch (q.type) {
    case 'select': {
      const v = await p.select({
        message: q.message,
        options: (q.options ?? []).map((o) => ({ value: o.value, label: o.label, hint: o.hint })),
        initialValue: q.default as string,
      });
      if (p.isCancel(v)) cancelAndExit();
      return v;
    }
    case 'multiselect': {
      const v = await p.multiselect({
        message: q.message,
        options: (q.options ?? []).map((o) => ({ value: o.value, label: o.label, hint: o.hint })),
        initialValues: q.default as string[],
        required: false,
      });
      if (p.isCancel(v)) cancelAndExit();
      return v;
    }
    case 'confirm': {
      const v = await p.confirm({ message: q.message, initialValue: Boolean(q.default) });
      if (p.isCancel(v)) cancelAndExit();
      return v;
    }
    case 'number': {
      const v = await p.text({
        message: `${q.message} (숫자, 기본 ${String(q.default)})`,
        placeholder: String(q.default),
        defaultValue: String(q.default),
        validate: (val) => {
          if (val.trim() === '') return undefined;
          if (Number.isNaN(Number(val))) return '숫자를 입력하세요';
        },
      });
      if (p.isCancel(v)) cancelAndExit();
      return v.trim() === '' ? q.default : Number(v);
    }
    case 'text': {
      const v = await p.text({ message: q.message, placeholder: String(q.default), defaultValue: String(q.default) });
      if (p.isCancel(v)) cancelAndExit();
      return v;
    }
  }
}

function cancelAndExit(): never {
  p.cancel('취소되었습니다 (canceled).');
  process.exit(1);
}

export async function runWizard(opts: WizardOptions): Promise<WizardConfig> {
  let config = emptyConfig() as WizardConfig;
  if (opts.existingRaw) config = deepMerge(config, opts.existingRaw) as WizardConfig;
  if (opts.overrides) {
    for (const [k, v] of Object.entries(opts.overrides)) {
      if (v === undefined) continue;
      const cfg = config as unknown as Record<string, unknown>;
      // Plain-object overrides (e.g. `cs: { enabled: true }`) shallow-merge over the existing
      // key instead of replacing it wholesale, so sibling defaults (cs.widget) survive.
      const existing = cfg[k];
      cfg[k] =
        v !== null && typeof v === 'object' && !Array.isArray(v) && existing !== null && typeof existing === 'object'
          ? { ...(existing as Record<string, unknown>), ...(v as Record<string, unknown>) }
          : v;
    }
  }

  if (!opts.yes) p.intro(pc.bold('paykit init — 결제 킷 위저드'));

  let lastGroup = '';
  let notedD13 = false;

  for (const q of QUESTIONS) {
    if (q.when && !q.when(config)) continue;

    const path = fullPath(q);
    // getPath-based (not a flat `in` check) so nested overrides like `cs: { enabled: true }` are
    // recognized for q.configPath === 'cs.enabled', not just top-level keys like 'providers'.
    const overridden =
      Boolean(q.configPath) && opts.overrides !== undefined &&
      getPath(opts.overrides as Record<string, unknown>, q.configPath!) !== undefined;
    const missing = isMissing(opts.existingRaw, path);

    let value: unknown;
    if (overridden) {
      // Already applied above; just read it back so downstream `when` predicates see it.
      value = getPath(config, path);
    } else if (!missing) {
      value = getPath(config, path);
    } else if (opts.yes) {
      // `--yes` must land on the same stored value an interactive run would, so the default goes
      // through `parse` too (e.g. a 0-day answer becomes `null`, not a 0-day expiry).
      value = q.parse ? q.parse(String(q.default)) : q.default;
    } else {
      if (q.group !== lastGroup) {
        p.note(q.ec.join(', '), GROUP_TITLES[q.group] ?? q.group);
        lastGroup = q.group;
      }
      value = await promptOne(q);
      if (q.parse && (typeof value === 'string' || typeof value === 'number')) value = q.parse(String(value));
      if (q.id === 'providers' && Array.isArray(value) && value.includes('toss') && !notedD13) {
        p.note(
          'Toss 가상계좌 환불은 환불 받을 계좌 정보가 필요합니다 (D13). 앱에서 수집한 계좌를 refund({ extra: { refundReceiveAccount } }) 에 전달하세요.',
          'Toss 참고',
        );
        notedD13 = true;
      }
    }

    setPath(config as unknown as Record<string, unknown>, path, value);
  }

  if (!opts.yes) p.outro(pc.green('질문 완료. paykit.config.json 을 생성합니다.'));
  return config;
}
