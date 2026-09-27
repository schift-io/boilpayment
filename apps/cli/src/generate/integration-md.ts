// INTEGRATION.md generator — how to wire the generated kit into a real app.
//
// Everything here is derived from the answers in paykit.config.json: the symbols named below are
// the ones `generateIndexTs`/`generateIndexPy` actually emit for THIS config, the paths are the
// configured paths, and a section only appears when the corresponding choice was made. A generic
// integration guide is worse than none — the reader cannot tell which half applies to them.
import type { PaykitConfig } from '../config.js';
import { backfillIntegrationSection, hasBackfill } from './backfill.js';

const KR_PROVIDERS = ['toss', 'portone'] as const;

function ts(config: PaykitConfig): boolean {
  return config.languages.includes('ts');
}
function py(config: PaykitConfig): boolean {
  return config.languages.includes('py');
}
/** Providers we must charge ourselves on a schedule (EC:A43: Toss and PortOne). */
function selfScheduled(config: PaykitConfig): string[] {
  if (!config.models.includes('subscription')) return [];
  const out: string[] = [];
  if (config.providers.includes('toss')) out.push('toss');
  if (config.providers.includes('portone')) out.push('portone');
  return out;
}
/** Providers whose payment is started by a client-side widget and confirmed server-side. */
function widgetProviders(config: PaykitConfig): string[] {
  return config.providers.filter((p) => (KR_PROVIDERS as readonly string[]).includes(p));
}
function hostedProviders(config: PaykitConfig): string[] {
  return config.providers.filter((p) => !(KR_PROVIDERS as readonly string[]).includes(p));
}

export function generateIntegrationMd(config: PaykitConfig): string {
  const l: string[] = [];
  const webhookPath = config.infra.webhookPath;
  const hasSubscription = config.models.includes('subscription');
  const hasUsage = config.models.includes('usage') || config.goods.includes('usage_quota');
  const hasTopup = config.models.includes('topup');
  const hasCredits = config.goods.includes('credits');
  const self = selfScheduled(config);
  const widget = widgetProviders(config);
  const hosted = hostedProviders(config);

  l.push('# 연동 가이드 — INTEGRATION.md');
  l.push('');
  l.push('`boilpayment init` 이 이 프로젝트의 선택(provider · 모델 · 언어 · CS · 로깅)에 맞춰 생성한 문서입니다.');
  l.push('여기 나오는 함수 이름은 `paykit/` 안에 실제로 생성된 것과 같습니다.');
  l.push('');
  l.push(`- Providers: \`${config.providers.join('`, `') || '(none)'}\``);
  l.push(`- Models: \`${config.models.join('`, `') || '(none)'}\``);
  l.push(`- Webhook: \`${webhookPath}\``);
  l.push(`- CS 사용량 보고: ${config.cs.enabled ? '켜짐' : '꺼짐'}`);
  l.push('');

  // ── 1. 설치 ────────────────────────────────────────────────────────────────
  l.push('## 1. 설치');
  l.push('');
  l.push('설치는 하나입니다. 내부 모듈은 이 패키지가 정확한 버전으로 물고 옵니다.');
  l.push('');
  l.push('```bash');
  if (ts(config)) l.push('npm i boilpayment-sdk');
  if (py(config)) l.push('pip install boilpayment');
  l.push('```');
  l.push('');
  l.push('레지스트리에 아직 없는 버전을 쓸 때는 받은 패키지 파일을 그대로 설치합니다');
  l.push(`(${[ts(config) ? '`npm i ./boilpayment-sdk-<버전>.tgz`' : '', py(config) ? '`pip install ./boilpayment-<버전>-py3-none-any.whl`' : ''].filter(Boolean).join(', ')}).`);
  l.push('마이그레이션 CLI 는 Node 로 돕니다(`npx boilpayment`). 설치한 SDK 와 같은 버전을 쓰세요: `npx boilpayment@<버전> migrate`.');
  l.push('');
  if (ts(config)) {
    l.push('**호스트 프로젝트는 ESM 이어야 합니다** — `package.json` 에 `"type": "module"`.');
    l.push('킷의 모든 패키지가 ESM 전용이라 CommonJS 에서 `require()` 하면');
    l.push('`ERR_PACKAGE_PATH_NOT_EXPORTED` 가 납니다. 패키지가 깨진 게 아니라 `require` 조건이 없어서입니다.');
    l.push('프로젝트를 통째로 옮길 수 없다면 호출부에서 동적 import 를 쓰세요:');
    l.push('`const kit = await import(\'./paykit/index.js\');`');
    l.push('');
  }
  l.push('그다음 순서대로:');
  l.push('');
  l.push('```bash');
  l.push('cp .env.example .env        # 실제 키를 채웁니다');
  l.push('npx boilpayment migrate          # 마이그레이션 적용 (--dry-run 으로 먼저 볼 수 있습니다)');
  l.push('npx boilpayment check            # 설정 검증 + DB 상태 (읽기 전용)');
  l.push('```');
  l.push('');
  l.push('`boilpayment migrate` 는 적용 이력을 `paykit_migrations` 에 남기므로 몇 번을 돌려도 안전합니다.');
  l.push('`paykit/migrations/*.sql` 을 `psql` 로 직접 때리지 마세요 — 이력이 남지 않아 다음 버전에서');
  l.push('무엇이 이미 적용됐는지 알 수 없게 됩니다.');
  l.push('');
  l.push('`boilpayment check` 는 DB 가 이 빌드보다 뒤처졌거나 앞서 있으면 **종료 코드 1** 로 끝납니다.');
  l.push('배포 파이프라인에서 앱을 띄우기 전 게이트로 그대로 쓸 수 있습니다.');
  l.push('');
  l.push('### 버전을 올릴 때');
  l.push('');
  l.push('패키지를 올리면 새 마이그레이션이 따라올 수 있습니다. 순서는 항상 같습니다.');
  l.push('');
  l.push('```bash');
  l.push('npm i boilpayment-sdk@latest');
  l.push('npx boilpayment migrate --dry-run   # 무엇이 적용될지 확인');
  l.push('npx boilpayment migrate');
  l.push('```');
  l.push('');
  l.push('**앱 부팅 시 `verifySchema()` 를 부르세요.** DB 가 코드보다 뒤처져 있으면 그 자리에서');
  l.push('멈춥니다. 안 부르면 새 컬럼을 처음 건드리는 쿼리가 운영 중에 죽습니다.');
  l.push('');
  if (ts(config)) {
    l.push('```ts');
    l.push('await kit.initialize();   // 스키마 확인 후 설정한 판매 플랜을 저장 (마이그레이션 실행 없음)');
    l.push('```');
    l.push('');
  } else {
    l.push('```python');
    l.push('await kit["initialize"]()   # 스키마 확인 후 설정한 판매 플랜 저장 (마이그레이션 실행 없음)');
    l.push('```');
    l.push('');
  }
  l.push('패키지를 되돌려서 DB 가 코드보다 **앞선** 경우도 잡아냅니다. 그때는 마이그레이션을 더');
  l.push('적용하는 게 아니라 패키지를 다시 올려야 합니다.');
  l.push('');
  if (config.models.includes('subscription') && config.providers.some((p) => p === 'toss' || p === 'portone')) {
    // Round-6 I-2: an older worker does not follow the attempt-lease rules of the new one (EC:A48).
    // Round-8 A8-1: 0.1.0 Python sent another idempotency key (its own time form), so two releases at once charge twice.
    l.push('**cron·워커는 옛 버전을 모두 내린 뒤 새 버전을 띄우세요.** 두 버전이 동시에 돌면 같은 갱신을');
    l.push('서로 다른 주문번호로 두 번 청구할 수 있습니다(0.1.0 Python 이 그렇습니다). 새 버전은 옛 버전의 청구를');
    l.push('조회로 찾지만, 둘이 같은 순간에 청구하면 서로를 볼 수 없습니다.');
    l.push('올린 뒤 첫 `schedulerTick` 전에 `npx boilpayment check` 로 밀린 구독과 결과를 모르는 청구를 확인하세요.');
    l.push('');
    l.push('### 담당자 알림(`cs.needs_human`)이 오면');
    l.push('');
    l.push('- `attempt_lookup_mismatch`: 결제사 주문이 보낸 청구와 달라(금액·통화·고객·환불) 그 갱신을 멈췄습니다.');
    l.push('  결제사 화면에서 확인한 뒤 `settle`(이 갱신이 맞음), `void`(돈이 움직이지 않음·전액 환불됨, 다음 날 다시 청구),');
    l.push('  `close`(일부 환불 등 돈이 움직였지만 킷은 지급·재청구 없이 그 기간을 넘김, 환불은 담당자가 처리) 중 하나로 정리합니다.');
    l.push('  `void` 는 결제사에 주문을 다시 물어 돈이 남아 있으면 거절합니다. 보류된 구독은 유예 기간이 끝나면 만료되니 그 안에 정리하세요.');
    l.push('- `renewal_double_charge`: 같은 기간에 결제가 두 번 들어왔습니다(이전 버전의 재시도). 두 번째 결제를 환불하세요.');
    l.push('- `missed_periods_parked`: 두 기간 이상 밀려 청구를 멈췄습니다. 이어서 받으려면 지금 기간부터 재개하고, 끝내려면 취소합니다.');
    l.push('');
    if (ts(config)) {
      l.push('```ts');
      l.push("import { resolveHeldAttempt, resumeParked } from 'boilpayment-sdk/lifecycle';");
      l.push("await resolveHeldAttempt({ paymentId, decision: 'settle', actor: 'ops@yourapp.com', provider, policy, ledger, repo, clock, notifier });");
      l.push("await resumeParked({ subscriptionId, actor: 'ops@yourapp.com', policy, repo, clock, notifier });");
      l.push('```');
    } else {
      l.push('```python');
      l.push('from boilpayment.lifecycle import resolve_held_attempt, resume_parked');
      l.push('await resolve_held_attempt(payment_id=payment_id, decision="settle", actor="ops@yourapp.com", provider=provider, policy=policy, ledger=ledger, repo=repo, clock=clock, notifier=notifier)');
      l.push('await resume_parked(subscription_id=subscription_id, actor="ops@yourapp.com", policy=policy, repo=repo, clock=clock, notifier=notifier)');
      l.push('```');
    }
    l.push('');
  }

  // ── 2. 결제 시작 ───────────────────────────────────────────────────────────
  l.push('## 2. 결제 시작');
  l.push('');
  if (hosted.length > 0) {
    l.push(`### ${hosted.join(' · ')} — 호스티드 페이지`);
    l.push('');
    l.push('`checkout` 이 결제 페이지 URL 을 돌려줍니다. 사용자를 그 URL 로 보내면 됩니다.');
    l.push('');
    if (ts(config)) {
      l.push('```ts');
      l.push(`const checkout = await kit.checkout({`);
      l.push(`  provider: '${hosted[0]}',`);
      l.push(`  customerId, planId, currency,`);
      l.push(`  successUrl: 'https://your.app/billing/done',`);
      l.push(`  cancelUrl: 'https://your.app/billing',`);
      l.push(`  requestId: purchaseAttemptId,`);
      l.push(`});`);
      l.push('```');
      l.push('');
    }
  }
  if (widget.length > 0) {
    l.push(`### ${widget.join(' · ')} — 클라이언트 위젯 + 서버 승인`);
    l.push('');
    l.push('**이 provider 들은 서버만으로 결제가 끝나지 않습니다.** 브라우저에서 결제창을 띄우고,');
    l.push('성공 콜백으로 받은 값을 **서버가 승인(confirm)** 해야 비로소 결제가 완결됩니다.');
    l.push('승인을 빠뜨리면 결제는 매달린 채로 남고 재화도 지급되지 않습니다.');
    l.push('');
    l.push('1. 클라이언트: provider 의 결제 위젯 SDK 로 결제창을 띄웁니다 (클라이언트 키 사용).');
    l.push('2. 성공 콜백에서 받은 값을 당신의 서버로 보냅니다.');
    l.push('3. 서버: provider 어댑터의 `confirmPayment` 를 호출합니다. **금액을 반드시 대조**하세요 —');
    l.push('   클라이언트가 보낸 금액을 그대로 믿으면 안 됩니다.');
    l.push('');
    if (config.models.includes('subscription')) {
      const self = widget.filter((p) => p === 'toss' || p === 'portone');
      if (self.length > 0) {
        l.push(`**${self.join(' · ')} 구독은 결제창이 아니라 빌링키로 시작합니다** (EC:A65). 결제창 결제를`);
        l.push('`registerCompletedCheckout` 로 등록하면 `use_start_subscription` 오류가 납니다.');
        l.push('');
        l.push('1. 클라이언트: 카드 등록창을 띄웁니다 (Toss `requestBillingAuth({ customerKey })`, PortOne `requestIssueBillingKey`).');
        l.push('2. 서버: 빌링키를 발급받습니다 (Toss 는 성공 콜백의 `authKey` 와 같은 `customerKey` 로 `issueBillingKey`).');
        l.push('3. 서버: `startSubscription` 으로 첫 기간을 청구하고 구독을 엽니다. 같은 `requestId` 로 다시 불러도 한 번만 청구합니다.');
        l.push('');
        if (ts(config)) {
          l.push('```ts');
          l.push('const { sub } = await kit.startSubscription({');
          l.push('  customerId, planId, currency: \'KRW\',');
          l.push('  billingKey,               // 2번에서 받은 값');
          l.push('  customerRef: customerKey, // Toss: 빌링키를 발급받은 customerKey');
          l.push('  requestId: signupAttemptId,');
          l.push('});');
          l.push('```');
          l.push('');
        }
        if (py(config)) {
          l.push('```python');
          l.push('result = await kit["start_subscription"](customer_id=customer_id, plan_id=plan_id, currency="KRW",');
          l.push('                                         billing_key=billing_key, customer_ref=customer_key, request_id=signup_attempt_id)');
          l.push('```');
          l.push('');
        }
        l.push('첫 청구가 거절되면 `subscription_start_declined`, 결과를 모르면 `subscription_start_unresolved` 입니다.');
        l.push('뒤의 경우 같은 `requestId` 로 다시 부르면 결제사에 먼저 물어보고 이어서 처리합니다.');
        l.push('');
      }
    }
  }

  l.push('결제 시작 전에 로그인 고객·설정 플랜·통화를 `checkout`에 전달하면 판매 시점의 가격과 지급 조건이 저장됩니다. 서버가 반환한 checkout.id를 해당 구매 시도와 함께 보관하세요.');
  l.push('실제 결제 후 신뢰할 수 있는 서버 콜백에서 `registerCompletedCheckout({ customerId, checkoutId: checkout.id, paymentRef })`를 호출합니다. PG 조회로 결제 연결·소유자·금액을 확인한 뒤 구매를 등록합니다. 등록 전 도착한 웹훅은 등록 후 재처리하거나 복구 작업으로 처리하세요.');
  if (py(config)) l.push('Python에서는 `kit["checkout"](customer_id=..., plan_id=..., provider=..., currency=..., request_id=..., success_url=..., cancel_url=...)`, 이후 `kit["register_completed_checkout"](customer_id=..., checkout_id=..., payment_ref=...)`를 호출합니다.');
  l.push('기존 플랜을 나중에 변경해도 이미 구매한 재화는 판매 당시 조건으로 지급합니다. 오래된 결제에 구매 근거가 없으면 자동 지급하지 않고 담당자 확인을 요청합니다.');
  l.push('');

  // ── 3. 웹훅 ────────────────────────────────────────────────────────────────
  l.push('## 3. 웹훅 연결');
  l.push('');
  l.push(`지급은 등록된 구매 근거와 검증된 PG 결제를 대조해 처리합니다. 성공 페이지로 돌아온 것만으로 지급하지 않습니다`);
  l.push('(사용자가 창을 닫아도 결제는 성립합니다).');
  l.push('');
  l.push(`\`${webhookPath}\` 에 마운트하고, provider 대시보드에 같은 URL 을 등록하세요.`);
  l.push('');
  l.push('**서명 검증은 원본 바디(raw body)를 그대로 넘겨야 통과합니다.** 프레임워크가 JSON 으로');
  l.push('파싱한 객체를 다시 문자열로 만들면 바이트가 달라져 검증이 실패합니다.');
  l.push('');
  const tossHook = config.providers.includes('toss');
  if (tossHook) {
    l.push('**Toss 웹훅은 서명이 없어 Toss 가 공개한 발신 주소에서 온 것만 받습니다** (EC:E18). 그래서 연결한');
    l.push('소켓의 주소를 `remoteAddress` 로 넘겨야 합니다. 헤더(`X-Forwarded-For`)는 누구나 쓸 수 있어 쓰지 않습니다.');
    l.push('Next.js 라우트 핸들러는 소켓 주소를 주지 않으므로 Toss 웹훅은 Express 같은 서버로 받으세요.');
    l.push('');
  }
  if (ts(config)) {
    l.push('```ts');
    if (tossHook) {
      l.push('// Express — raw body 로 받습니다');
      l.push(`app.post('${webhookPath}', express.raw({ type: '*/*' }), async (req, res) => {`);
      l.push('  const raw = req.body.toString(\'utf8\');       // ← 파싱하지 말 것');
      l.push('  const result = await kit.handleWebhook(raw, req.headers as Record<string, string>, { remoteAddress: req.socket.remoteAddress });');
      l.push('  res.status(result.status).end();');
      l.push('});');
    } else {
      l.push('// Next.js app router — app' + webhookPath + '/route.ts');
      l.push("export async function POST(req: Request) {");
      l.push('  const raw = await req.text();                 // ← 파싱하지 말 것');
      l.push('  const headers = Object.fromEntries(req.headers);');
      l.push('  const res = await kit.handleWebhook(raw, headers);');
      l.push('  return new Response(null, { status: res.status });');
      l.push('}');
    }
    l.push('```');
    l.push('');
  }
  if (py(config)) {
    l.push('```python');
    l.push('# FastAPI');
    l.push(`@app.post("${webhookPath}")`);
    l.push('async def paykit_webhook(request: Request):');
    l.push('    raw = (await request.body()).decode()        # ← 파싱하지 말 것');
    l.push(`    res = await kit["handle_webhook"](raw, dict(request.headers)${tossHook ? ', remote_address=request.client.host if request.client else None' : ''})`);
    l.push('    return Response(status_code=res.status)            # ReceiveResult: 속성으로 읽습니다');
    l.push('```');
    l.push('');
  }
  l.push('웹훅은 즉시 200 을 돌려주고 처리는 비동기로 갑니다. provider 의 재전송·순서 뒤바뀜·중복은');
  l.push('전부 전제되어 있으므로, 같은 이벤트가 두 번 와도 지급은 한 번만 일어납니다.');
  l.push('');

  // ── 4. 앱에서 부르는 것 ────────────────────────────────────────────────────
  l.push('## 4. 앱에서 부르는 것');
  l.push('');
  const rows: string[] = ['| 하는 일 | 호출 |', '|---|---|'];
  if (hasCredits) rows.push('| 재화 차감 | `consume({ customerId, amount, idempotencyKey })` |');
  if (hasUsage) {
    rows.push('| 사용량 기록 | `record({ event })` |');
    rows.push('| 한도 확인 | `checkQuota({ customerId, meter, quantity, sub })` |');
  }
  if (hasSubscription) {
    rows.push('| 업그레이드 | `upgrade({ sub, newPlan })` |');
    rows.push('| 다운그레이드 | `downgrade({ sub, newPlan })` |');
    rows.push('| 취소 | `cancel({ sub, churnReason })` |');
    rows.push('| 취소 철회 | `reactivate({ sub })` |');
    if (config.providers.some((p) => p === 'toss' || p === 'portone')) {
      rows.push('| 빌링키로 구독 시작 (EC:A65) | `startSubscription({ customerId, planId, currency, billingKey, customerRef, requestId })` |');
      rows.push('| 검토 보류된 갱신 결정 (EC:A58) | `resolveHeldAttempt({ paymentId, decision, actor })` |');
    }
  }
  rows.push('| 규칙에 따른 환불 | `support.requestRefund({ customerId, paymentId, requestId, requestedAmount })` |');
  if (hasCredits) rows.push('| 미지급 복구 | `support.recoverMissingGrant({ customerId, paymentId })` |');
  const hasReservations = hasCredits && config.reservations === true;
  if (config.reports === true) rows.push(py(config) && !ts(config) ? '| 월 정산 집계 (EC:I10) | `reports["settlement"](start=..., end=...)` |' : '| 월 정산 집계 (EC:I10) | `reports.settlement({ from, to })` |');
  if (hasReservations) {
    rows.push('| 작업 예산 잡기 (EC:C10) | `reservations.reserve({ customerId, jobId, amount })` |');
    rows.push('| 작업 성공: 쓴 만큼 청구 | `reservations.commit({ customerId, jobId, amount })` |');
    rows.push('| 작업 실패·취소: 청구 없음 | `reservations.release({ customerId, jobId })` |');
  }
  l.push(...rows);
  l.push('');
  if (hasReservations) {
    l.push('오래 걸리는 작업은 시작 전에 `reservations.reserve`로 크레딧을 잡습니다. 남은 예산(잔액에서 살아 있는 예약을 뺀 값)이 모자라면 `{ ok: false, need, available }`가 돌아오니 그 값으로 사용자에게 부족분을 보여 줍니다.');
    l.push(`같은 \`jobId\`로 다시 불러도 한 번만 잡힙니다. 작업이 성공하면 \`commit\`이 실제 사용량(예약 이하)만 청구하고 나머지를 풀고, 실패하면 \`release\`가 청구 없이 풉니다. ${config.policy.usage.reservationTtlMinutes}분 안에 둘 다 없으면 \`cron.sweepReservations()\`가 풉니다.`);
    l.push('');
  }
  l.push('고객·결제 ID를 넘기면 저장된 결제 근거와 판매자 규칙으로 환불 여부와 금액을 계산하고 실행합니다.');
  if (Object.values(config.policy.refund.reasons ?? {}).some((v) => v !== 'rules')) {
    l.push('환불 사유 규칙(EC:D16)을 켰으므로 `reason: { category, evidenceRef }`를 같이 넘깁니다. category는 `technical_failure` · `dissatisfied` · `user_error` · `other`이고, 사유를 넘기지 않으면 금액 규칙만 적용됩니다.');
  }
  l.push('고객 ID는 로그인 세션에서 가져오세요. 요청 본문의 고객 ID나 임의 환불 판정을 신뢰하지 마세요.');
  if (py(config)) l.push('Python은 `kit["support"]["request_refund"](customer_id=..., payment_id=..., request_id=..., requested_amount=Money(...))`를 사용합니다.');
  l.push('');

  // ── 5. 크론 ────────────────────────────────────────────────────────────────
  l.push('## 5. 반드시 돌려야 하는 크론');
  l.push('');
  l.push('**이걸 안 걸면 조용히 망가집니다.** 에러가 나지 않고 그냥 아무 일도 일어나지 않습니다.');
  l.push('');
  l.push('| 작업 | 주기 | 안 돌리면 |');
  l.push('|---|---|---|');
  if (self.length > 0) {
    l.push(`| \`cron.schedulerTick()\` | 5–15분 | **${self.join('·')} 구독의 갱신 결제가 아예 일어나지 않습니다** |`);
  }
  if (hasSubscription) l.push('| `cron.dunningSweep()` | 1시간 | 유예 기간이 끝나도 정리되지 않습니다 |');
  if (hasCredits) l.push('| `cron.expireDue()` | 1일 | 만료 처리가 원장에 기록되지 않습니다 |');
  if (hasUsage) l.push('| `cron.closePeriods()` | 1일 | 마감된 이용량의 직접 청구·재확인을 처리하지 못합니다 |');
  l.push('| `cron.flushOutbox()` | 5분 | provider 사용량 보고와 알림이 밀립니다 |');
  l.push('| `cron.reconcile(since)` | 1일 | 저장된 결제의 미지급을 확인·복구하지 못합니다 |');
  if (hasCredits && config.reservations === true) l.push('| `cron.sweepReservations()` | 5분 | 확정도 해제도 안 된 작업 예약이 예산을 계속 막습니다 |');
  l.push('');
  if (self.length > 0) {
    l.push(`> \`${self.join('`, `')}\` 는 provider 쪽에 구독이라는 개념이 없어, **우리가 빌링키로 직접 청구**합니다.`);
    l.push('> `schedulerTick` 이 그 청구를 겁니다. 이것만은 빠뜨리면 안 됩니다.');
    l.push('> 구독 하나가 실패해도 나머지는 계속 갱신되고, 실패는 반환값의 `errors` 에 구독별로 담기며 로거에도 `scheduler.error` 로 남습니다.');
    l.push('> 같은 호출이 기한이 된 dunning 재시도도 처리합니다. 결과를 모르는 청구는 구독을 유예(past_due)로 한 번 옮기고 담당자 알림을 한 번 보낸 뒤, 다음 호출마다 같은 키로 다시 확인합니다(새로 청구하지 않습니다).');
    l.push('');
  }

  l.push('## 6. 환불과 미지급 처리');
  l.push('');
  l.push('환불·재지급·분쟁 처리는 기본으로 연결됩니다. `cs.enabled`는 선택적인 CS 사용량 보고 설정입니다.');
  l.push('환불은 결제 소유권·PG 결제 상태·남은 환불 가능액·설정된 한도를 확인합니다. 규칙 밖 요청은 케이스에 거절 또는 담당자 확인 상태를 남깁니다.');
  l.push('`cron.reconcile(since)`는 저장된 결제 중 지급이 누락된 건을 확인하고, 판매 시점에 기록한 구매 근거와 설정 규칙에 따라 재지급합니다. 근거가 부족하면 담당자 확인 케이스를 남깁니다.');
  l.push('이 코드는 고객 문의를 읽는 호스팅 AI 상담 서비스나 채팅 위젯을 포함하지 않습니다.');
  l.push('');

  // ── 7. 기존 고객 들이기 (EC:M1, 있다고 답했을 때만) ─────────────────────────
  if (hasBackfill(config)) l.push(...backfillIntegrationSection(config, 7));

  // ── 7/8. 문제 생겼을 때 ────────────────────────────────────────────────────
  const n = hasBackfill(config) ? 8 : 7;
  l.push(`## ${n}. 문제가 생겼을 때`);
  l.push('');
  l.push('"이 결제에 무슨 일이 있었나"에 답하는 게 이 킷을 쓰는 이유입니다.');
  l.push('결제·원장·웹훅·환불·케이스가 흩어져 있어도 하나의 시간순 이야기로 봅니다.');
  l.push('');
  if (ts(config)) {
    l.push('```ts');
    l.push("import { timeline, explain } from 'boilpayment-sdk/cs';");
    l.push('const { events } = await timeline({ paymentId, repo, ledger, clock });');
    l.push('console.log(explain(events).join("\\n"));');
    l.push('```');
  } else {
    l.push('```python');
    l.push('from boilpayment.cs import timeline, explain');
    l.push('res = await timeline(payment_id=payment_id, repo=repo, ledger=ledger, clock=clock)');
    l.push('print("\\n".join(explain(res.events)))');
    l.push('```');
  }
  l.push('');
  l.push('출력 예시:');
  l.push('');
  l.push('```');
  l.push('payment pay_1 succeeded (₩9,900)');
  l.push('100 credits granted');
  l.push('40 credits consumed');
  l.push('refund D1 for ₩6,000, 60 credits revoked');
  l.push('balance now 0');
  l.push('```');
  l.push('');
  if (config.infra.logging !== 'none') {
    l.push(`로깅이 \`${config.infra.logging}\` 로 켜져 있어 provider 와 주고받은 요청·응답도 남습니다.`);
    l.push('카드번호·주민번호·시크릿키는 기록 전에 가려집니다.');
    l.push('');
  } else {
    l.push('⚠ 로깅이 꺼져 있습니다. provider 와 주고받은 내용이 남지 않아, 분쟁 시 우리 쪽 기록만으로 다퉈야 합니다.');
    l.push('');
  }

  // ── 8. 검증 ────────────────────────────────────────────────────────────────
  l.push(`## ${n + 1}. 연동 검증`);
  l.push('');
  l.push('`.env` 를 채운 뒤 실제 provider API 에 왕복을 겁니다. mock 이 아닙니다.');
  l.push('');
  l.push('```bash');
  l.push('npx boilpayment live            # --dry-run 으로 무엇이 돌지 먼저 볼 수 있습니다');
  l.push('```');
  l.push('');
  if (config.providers.includes('toss')) {
    l.push('Toss 는 문서에 공개된 테스트 키로 발급 → 승인 → 부분취소까지 실제로 돕니다.');
    l.push('테스트 카드는 `.env.example` 의 더미 번호를 쓰세요. **다른 카드번호는 빌링키까지는 나와도**');
    l.push('**결제 단계에서 거부될 수 있습니다** — 테스트 환경은 카드 앞 6자리(BIN)만 유효하면 됩니다.');
    l.push('');
  }

  // ── 9. 한계 ────────────────────────────────────────────────────────────────
  const limits: string[] = [];
  if (config.providers.includes('polar')) {
    limits.push('- **Polar**: 결제 기준일 리셋을 지원하지 않습니다. 업그레이드를 `reset_anchor` 로 설정해도 기준일은 유지됩니다.');
    limits.push('- **Polar**: 실계정 검증이 되어 있지 않습니다(공식 스펙 대조와 로컬 목 서버까지).');
  }
  if (config.providers.includes('toss')) {
    limits.push('- **Toss**: 거래 조회 API 가 방금 만든 결제를 곧바로 보여주지 않고 다른 상점 건이 섞여 나옵니다. 대사(reconcile)의 근거로 쓰지 마세요.');
  }
  if (config.providers.includes('portone')) {
    limits.push('- **PortOne**: 실계정 검증이 되어 있지 않습니다(공식 OpenAPI 스펙 대조까지).');
    limits.push('- **PortOne**: 현금영수증 취소는 전액만 지원합니다(부분 취소 없음).');
  }
  if (widget.length > 0) {
    limits.push('- **현금영수증**: 카드 결제는 대상이 아닙니다. 계좌이체·가상계좌 같은 현금성 결제에만 발급됩니다.');
  }
  if (hasTopup && hasCredits) {
    limits.push('- **충전 크레딧 만료**: 기본은 무만료입니다. 만료를 두려면 위저드에서 일수를 지정하세요.');
  }
  if (limits.length > 0) {
    l.push(`## ${n + 2}. 알아둘 한계`);
    l.push('');
    l.push(...limits);
    l.push('');
  }

  l.push('---');
  l.push('');
  l.push('정책 선택의 의미는 `POLICY.md` 에 문장으로 정리돼 있습니다.');
  l.push('`paykit.config.json` 을 고친 뒤에는 `boilpayment check` 를 다시 돌리세요.');
  l.push('');
  return l.join('\n');
}
