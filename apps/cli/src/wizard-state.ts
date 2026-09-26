// Wizard-time config: PaykitConfig plus transient answer-gating flags that are NOT
// written to paykit.config.json (they only decide which questions run).
import type { PaykitConfig } from './config.js';

export interface WizardConfig extends PaykitConfig {
  /** 사용자가 트라이얼을 제공한다고 답했는지 (A9/A10/A11 게이트). config.json 에는 저장 안 함. */
  trialEnabled?: boolean;
  /** 고급 환불 옵션(D7/D10/D16) 질문을 볼지 여부. config.json 에는 저장 안 함. */
  refundAdvanced?: boolean;
  /** 크레딧 고급 옵션(B19 출처별 기본 만료) 질문을 볼지 여부. config.json 에는 저장 안 함. */
  creditsAdvanced?: boolean;
  /** CS SDK API 키 (PAYKIT_API_KEY) — 비밀값이라 config.json 에는 저장 안 함. .env.example/env 로만 나간다. */
  csApiKey?: string;
}

const TRANSIENT_KEYS = ['trialEnabled', 'refundAdvanced', 'creditsAdvanced', 'csApiKey'] as const;

/** Strip transient wizard-only flags before persisting to paykit.config.json. */
export function toPaykitConfig(wc: WizardConfig): PaykitConfig {
  const out = { ...wc } as Record<string, unknown>;
  for (const k of TRANSIENT_KEYS) delete out[k];
  // EC:M1 — "no existing customers" leaves paykit.config.json exactly as it was before the question existed.
  if (!wc.situation?.existingCustomers) delete out.situation;
  // EC:C10 — reservations off leaves the config as it was before the question existed.
  if (!wc.reservations) delete out.reservations;
  if (!wc.reports) delete out.reports; // EC:I10 — same: off leaves the config as before
  return out as unknown as PaykitConfig;
}
