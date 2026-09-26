// POLICY.md generator — human-readable policy summary.
// Each applicable policy key
// gets its EC id, the choice made, and a one-sentence plain-language consequence (KO + EN).
import { QUESTIONS } from '../questions.js';
import { getPath } from '../util/path.js';
import { consequenceFor } from './consequences.js';
import type { PaykitConfig } from '../config.js';

function fmtValue(v: unknown): string {
  if (v === null) return 'null';
  return String(v);
}

export function generatePolicyMd(config: PaykitConfig): string {
  const lines: string[] = [];
  lines.push('# Policy Summary — POLICY.md');
  lines.push('');
  lines.push('이 문서는 `paykit init` 위저드에서 선택한 정책을 사람이 읽을 수 있게 요약한 것입니다.');
  lines.push('This document is a human-readable summary of the policy choices made in the `paykit init` wizard.');
  lines.push('');
  lines.push(`- Providers: ${config.providers.join(', ') || '(none)'}`);
  lines.push(`- Models: ${config.models.join(', ') || '(none)'}`);
  lines.push(`- Goods: ${config.goods.join(', ') || '(none)'}`);
  lines.push(`- Logging (docs/EDGE_CASES.md §L): \`${config.infra.logging}\`${config.infra.logging === 'none' ? ' — ⚠ 결제 실패를 재구성할 증거가 남지 않습니다' : ''}`);
  lines.push('');
  lines.push('---');
  lines.push('');

  const applicability = { ...config, refundAdvanced: true, trialEnabled: config.plans.some((plan) => plan.trialDays > 0) };
  let lastGroup = '';
  for (const q of QUESTIONS) {
    if (!q.policyPath) continue;
    if (q.when && !q.when(applicability)) continue;
    const value = getPath(config.policy, q.policyPath);
    if (value === undefined) continue;

    if (q.group !== lastGroup) {
      lines.push(`## ${q.group}`);
      lines.push('');
      lastGroup = q.group;
    }

    const conseq = consequenceFor(q.policyPath, value);
    lines.push(`### [EC:${q.ec.join(',')}] \`policy.${q.policyPath}\``);
    lines.push('');
    lines.push(`- 선택 (Choice): \`${fmtValue(value)}\``);
    if (conseq) {
      lines.push(`- KO: ${conseq.ko}`);
      lines.push(`- EN: ${conseq.en}`);
    } else {
      lines.push(`- (설명 없음 / no consequence text registered for this value)`);
    }
    if (q.policyPath === 'upgrade.mode' && value === 'immediate_prorate_reset_anchor' && config.providers.includes('polar')) {
      lines.push(
        '- ⚠ Provider 예외 (Polar): Polar 는 billing anchor 리셋을 지원하지 않아, 선택한 Provider 에 Polar 가 포함되어 있으면 ' +
          'Polar 구독에 한해 `immediate_prorate_keep_anchor` 처럼(기준일 유지) 동작합니다.',
      );
      lines.push(
        '- ⚠ Provider exception (Polar): Polar has no billing-anchor-reset concept, so for Polar subscriptions this behaves like ' +
          '`immediate_prorate_keep_anchor` (anchor is kept) even though `reset_anchor` was chosen.',
      );
    }
    lines.push('');
  }

  lines.push('---');
  lines.push('');
  lines.push('## 플랜 (Plans)');
  lines.push('');
  for (const plan of config.plans) {
    lines.push(`### ${plan.name} (\`${plan.id}\`)`);
    lines.push('');
    lines.push(`- 주기 (interval): ${plan.interval ?? 'one-time'}`);
    if (config.goods.includes('credits')) lines.push(`- 주기당 크레딧 (credits/period): ${plan.creditsPerPeriod}`);
    if (config.goods.includes('usage_quota')) lines.push(`- 주기당 포함 이용량 (usage included/period): ${plan.usageIncluded}`);
    if (plan.trialDays > 0) lines.push(`- 트라이얼 (trial): ${plan.trialDays}일`);
    for (const price of plan.prices) lines.push(`- 가격 (price): ${price.currency} ${price.amountMinor} (minor unit)`);
    lines.push('');
  }

  return lines.join('\n');
}
