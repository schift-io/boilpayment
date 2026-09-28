// paykit.config.json shape + read/write.
// Policy sub-object is the core Policy type (camelCase), resolved via the SDK facade.
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { DEFAULT_POLICY, resolvePolicy } from 'boilpayment-sdk/core';
import type { Policy, ProviderName } from 'boilpayment-sdk/core';

export type PaymentModel = 'subscription' | 'topup' | 'usage';
export type Good = 'credits' | 'usage_quota';
export type Language = 'ts' | 'py';
export type OrmChoice = 'none' | 'prisma' | 'drizzle' | 'sqlalchemy';
export type EmailNotifyChoice = 'none' | 'resend' | 'smtp';
export type SchedulerChoice = 'provider' | 'self';
export type LoggingChoice = 'none' | 'console' | 'postgres';

export interface PlanPriceConfig {
  currency: string;
  amountMinor: number;
  providerPriceRefs?: Partial<Record<ProviderName, string>>;
}

export interface PlanConfig {
  id: string;
  name: string;
  interval: 'month' | 'year' | null;
  creditsPerPeriod: number;
  usageIncluded: number;
  trialDays: number;
  prices: PlanPriceConfig[];
}

/** EC:M1 — what the developer already has. Stored only when existingCustomers is true. */
export type ExistingGood = 'subscriptions' | 'credits';
export interface SituationConfig {
  existingCustomers: boolean;
  providers: ProviderName[];
  has: ExistingGood[];
}

export interface PaykitConfig {
  version: 1;
  situation?: SituationConfig;
  providers: ProviderName[];
  models: PaymentModel[];
  goods: Good[];
  languages: Language[];
  policy: Policy;
  infra: {
    database: 'postgres';
    orm: OrmChoice;
    webhookPath: string;
    notify: { email: EmailNotifyChoice; slack: boolean };
    scheduler: SchedulerChoice;
    /** EC:L1-L5 (docs/EDGE_CASES.md §L) — which Logger the generated paykit/index.{ts,py} wires up. */
    logging: LoggingChoice;
  };
  /** enabled controls optional usage reporting; support rules and durable cases are always included. */
  cs: { enabled: boolean; widget: boolean };
  /** EC:C10 — generate kit.reservations (reserve/commit/release) and cron.sweepReservations. Needs credits. */
  reservations?: boolean;
  /** EC:I10 — generate kit.reports.settlement (monthly settlement totals). */
  reports?: boolean;
  plans: PlanConfig[];
}

export const CONFIG_FILENAME = 'paykit.config.json';

/** Bare defaults before any wizard answers are applied. */
export function emptyConfig(): PaykitConfig {
  return {
    version: 1,
    providers: [],
    models: [],
    goods: [],
    languages: [],
    policy: structuredClone(DEFAULT_POLICY),
    infra: {
      database: 'postgres',
      orm: 'none',
      webhookPath: '/api/webhook/paykit',
      notify: { email: 'none', slack: false },
      // Toss 는 네이티브 구독이 없어 항상 self 로 동작 (이 필드와 무관). Portone 은 이 필드를
      // 따르며 기본값은 provider 측 스케줄 (V2 schedule API).
      scheduler: 'self',
      // database 가 항상 'postgres' 라 기본값도 postgres — CS 는 결제 실패에 대한 지원이 제품이라
      // 증거 트레일이 없으면 조사가 안 된다 (docs/EDGE_CASES.md §L 배경 설명 참고).
      logging: 'postgres',
    },
    cs: { enabled: false, widget: false },
    plans: [],
  };
}

export async function configExists(dir: string): Promise<boolean> {
  try {
    await fs.access(path.join(dir, CONFIG_FILENAME));
    return true;
  } catch {
    return false;
  }
}

export async function readConfig(dir: string): Promise<PaykitConfig | null> {
  try {
    const raw = await fs.readFile(path.join(dir, CONFIG_FILENAME), 'utf8');
    const parsed = JSON.parse(raw) as PaykitConfig;
    // Re-resolve policy through core so partial/older configs still validate + fill new keys.
    parsed.policy = resolvePolicy(parsed.policy as Partial<Policy>);
    return parsed;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
}

export async function writeConfig(dir: string, config: PaykitConfig): Promise<string> {
  const file = path.join(dir, CONFIG_FILENAME);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(file, JSON.stringify(config, null, 2) + '\n', 'utf8');
  return file;
}
