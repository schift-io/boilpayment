// Minimal plan collection. Not part of questions.ts (plans are example data, not an
// EDGE_CASES.md policy key) — see docs/ARCHITECTURE.md.
import * as p from '@clack/prompts';
import type { ProviderName } from '@schift/payment-kit-core';
import type { PlanConfig } from './config.js';
import type { WizardConfig } from './wizard-state.js';
import type { WizardOptions } from './wizard.js';

function defaultPlan(config: WizardConfig): PlanConfig {
  const hasCredits = config.goods.includes('credits');
  const hasUsageQuota = config.goods.includes('usage_quota');
  const hasSubscription = config.models.includes('subscription');
  return {
    id: 'default',
    name: 'Pro',
    interval: hasSubscription ? 'month' : null,
    creditsPerPeriod: hasCredits ? 1000 : 0,
    usageIncluded: hasUsageQuota ? 1000 : 0,
    trialDays: config.trialEnabled ? 7 : 0,
    prices: [{ currency: config.providers.includes('toss') ? 'KRW' : 'USD', amountMinor: config.providers.includes('toss') ? 9900 : 1999 }],
  };
}

function cancelAndExit(): never {
  p.cancel('취소되었습니다 (canceled).');
  process.exit(1);
}

export async function collectPlans(config: WizardConfig, opts: WizardOptions): Promise<PlanConfig[]> {
  if (opts.existingRaw && Array.isArray((opts.existingRaw as Record<string, unknown>).plans) && (opts.existingRaw as Record<string, unknown>).plans as unknown[] && ((opts.existingRaw as { plans: unknown[] }).plans.length > 0)) {
    return (opts.existingRaw as { plans: PlanConfig[] }).plans;
  }
  if (opts.yes) return [defaultPlan(config)];

  p.note('기본 플랜 하나를 만듭니다. 더 필요하면 생성 후 paykit.config.json 의 plans[] 를 직접 편집하세요.', '플랜 (Plans)');

  const name = await p.text({ message: '플랜 이름', defaultValue: 'Pro', placeholder: 'Pro' });
  if (p.isCancel(name)) cancelAndExit();

  let interval: 'month' | 'year' | null = null;
  if (config.models.includes('subscription')) {
    const iv = await p.select({
      message: '결제 주기',
      options: [
        { value: 'month', label: '월간' },
        { value: 'year', label: '연간' },
      ],
      initialValue: 'month',
    });
    if (p.isCancel(iv)) cancelAndExit();
    interval = iv as 'month' | 'year';
  }

  let creditsPerPeriod = 0;
  if (config.goods.includes('credits')) {
    const v = await p.text({ message: '주기당 지급 크레딧', defaultValue: '1000', placeholder: '1000' });
    if (p.isCancel(v)) cancelAndExit();
    creditsPerPeriod = Number(v);
  }

  let usageIncluded = 0;
  if (config.goods.includes('usage_quota')) {
    const v = await p.text({ message: '주기당 포함 이용량', defaultValue: '1000', placeholder: '1000' });
    if (p.isCancel(v)) cancelAndExit();
    usageIncluded = Number(v);
  }

  let trialDays = 0;
  if (config.trialEnabled) {
    const v = await p.text({ message: '트라이얼 일수', defaultValue: '7', placeholder: '7' });
    if (p.isCancel(v)) cancelAndExit();
    trialDays = Number(v);
  }

  const currency = await p.select({
    message: '가격 통화',
    options: [
      { value: 'USD', label: 'USD' },
      { value: 'KRW', label: 'KRW' },
      { value: 'JPY', label: 'JPY' },
      { value: 'EUR', label: 'EUR' },
    ],
    initialValue: config.providers.includes('toss') ? 'KRW' : 'USD',
  });
  if (p.isCancel(currency)) cancelAndExit();

  const amount = await p.text({
    message: `가격 (${currency}, minor unit — 예: USD 1999 = $19.99, KRW 9900 = 9900원)`,
    defaultValue: currency === 'KRW' || currency === 'JPY' ? '9900' : '1999',
  });
  if (p.isCancel(amount)) cancelAndExit();

  const providerPriceRefs: Partial<Record<ProviderName, string>> = {};
  for (const provider of config.providers) {
    if (provider !== 'stripe' && provider !== 'polar') continue;
    const reference = await p.text({
      message: `${provider}에 등록한 ${provider === 'stripe' ? 'Price ID' : 'Product ID'} (비우면 초안으로 저장)`,
      defaultValue: '',
    });
    if (p.isCancel(reference)) cancelAndExit();
    if (reference.trim()) providerPriceRefs[provider] = reference.trim();
  }

  return [
    {
      id: 'default',
      name: name || 'Pro',
      interval,
      creditsPerPeriod,
      usageIncluded,
      trialDays,
      prices: [{ currency: String(currency), amountMinor: Number(amount), ...(Object.keys(providerPriceRefs).length ? { providerPriceRefs } : {}) }],
    },
  ];
}
