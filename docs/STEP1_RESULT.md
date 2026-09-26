# Step 1 구현 및 검증 결과

2026-09-10. 코드·로컬 통합 검증 완료. 이후 공식 공개 키로 **Stripe 실제 test API의 결제·부분 환불·멱등 재실행을 확인**했다. Stripe 실제 이벤트의 CLI 로컬 전달·Kit 서명 검증도 확인했다. Toss는 인증 확인까지 진행했으며 나머지 전체 검증은 남아 있다. 상세는 [공개 키 검증](PUBLIC_SANDBOX_VERIFICATION.md)을 따른다.

## 생성 프로젝트에서 연결된 기능

| 진입점 (TS / Python) | 동작 |
|---|---|
| `initialize` | 스키마 준비 여부 확인과 설정 상품 등록. 운영 DB migration을 자동 실행하지 않는다. |
| `checkout` | 결제사 호출 전에 판매 당시 상품·가격·지급량·규칙을 immutable snapshot으로 저장. 같은 요청의 결과 재사용. |
| `registerCompletedCheckout` / `register_completed_checkout` | 실제 결제와 해당 checkout의 소유자·금액·통화·식별 근거를 대조한 뒤 로컬 거래와 구매 근거 등록. |
| `support.requestRefund` / `support["request_refund"]` | ID로 거래 조회·규칙 판정·실제 provider 환불·케이스 결과까지 처리. 호출자가 승인 판정이나 재지급량을 입력하지 않는다. |
| `support.recoverMissingGrant` / `support["recover_missing_grant"]` | 현재 상품값을 추측하지 않고 구매 snapshot의 지급량·만료·기존 멱등키로 복구. |
| `handleWebhook` / `handle_webhook` | 실제 refund ID와 상태를 사용해 pending의 원래 환불·hold·CS 케이스를 완료하거나 실패 상태로 정리. |
| `cron.reconcile` | 로컬 거래의 미지급 조사와 규칙에 따른 복구 실행. |
| `cron.closePeriods` / `cron["close_periods"]` | 확인된 마감 기간의 초과 사용량을 직접 청구하거나 native meter로 보고. 보고와 수금 완료를 구분. |

Step 1 기능과 CS case 저장은 선택적 Schift 사용량 보고 설정(`cs.enabled`) 없이도 동작한다.
호출은 애플리케이션 서버에서 인증된 고객 문맥으로 수행한다. 고객 로그인과 권한은 애플리케이션이
맡고, Kit는 공개 무인증 HTTP API를 생성하지 않는다.

## Bad Case 보강

- Memory·Postgres에서 atomic operation claim. 최초 동시 요청과 실패 재시도는 실행자 한 명만 선점한다.
- 구매 시점 snapshot과 환불 provider checkpoint는 일반 7일 operation 정리에서 제외한다.
- 환불 응답 유실은 실패로 지어내거나 재호출하지 않고 pending 상태와 hold를 보존한다.
- provider 성공 후 로컬 저장 실패는 보관한 응답으로 로컬 작업만 재개한다.
- 직접 초과 청구는 요청을 먼저 commit하고 network 호출을 transaction 밖에서 실행한다.
  응답 유실 뒤 늦은 사용량이 들어와도 기존 청구 키를 복구한 다음 추가분을 별도로 처리한다.
- 초기 지급과 재지급·늦은 webhook이 동일한 구매 멱등키를 사용한다. 같은 처리의 CS case와 과금 보고도 중복하지 않는다.
- 상품이 100 credits에서 900 credits로 바뀐 뒤에도 이전 구매는 100만 지급한다.

## 검증



| 검사 | 결과 |
|---|---|
| 전체 build / TypeScript typecheck / Ruff | PASS |
| `pnpm run test` | 989 passed |
| `bash scripts/ci-pytest.sh` | 851 passed; 외부 httpx deprecation warning 1건 |
| `pnpm run test:verification` | 20 passed |
| `bash scripts/parity.sh` | 13/13 시나리오 PASS |
| `bash scripts/live.sh` | 로컬 HTTP provider mocks 8/8 PASS |
| `pnpm run test:step1` | 새 생성물 TS/Python 각각 7개 시나리오 묶음 PASS |
| `pnpm run test:step1:postgres` | 실제 격리 Postgres에서 동일하게 각각 7개 묶음 PASS |
| `git diff --check` | PASS |

생성물 실행은 실제 PortOne adapter와 loopback HTTP fixture를 사용했다. 자세한 관측값과
재현 방법은 [STEP1_E2E.md](STEP1_E2E.md)에 있다. 새 Postgres DB만 만들고 제거했으며 운영 DB는 변경하지 않았다.
Python 별도 정적 타입 검사기는 미설치여서 실행하지 않았다.

## 호환성·남은 검증

- 새 migration `0007_subscription_provider_ref_nullable.sql`은 self-scheduled 구독의 실제 nullable
  provider reference를 반영한다. 파일만 제공하며 기존 운영 DB 적용은 하지 않았다.
- 사용자 정의 `Repo.operations` 구현에는 atomic `claim` 계약이 추가된다.
- 초기 구매 snapshot이 없는 과거 거래나 checkout/subscription 연결 증거가 없는 경로는
  현재 요금제로 추정해 실행하지 않고 명시적으로 보류한다. Native checkout 실거래는 아직 미검증이다.
- Native meter 보고는 `awaiting_provider_billing`이며, 실제 청구 완료를 뜻하지 않는다.
  결제사 측 meter·price 설정과 sandbox 거래 검증이 필요하다.
- 정산 확정과 외부 webhook이 같은 provider reference를 동시에 삽입하면 고유 제약 충돌로
  미확정 상태를 유지할 수 있다. 새 키로 재청구하거나 완료로 보고하지 않으며 추가 대조가 필요하다.
- 개인 계정 키는 환경에 없지만 공식 공개 Stripe 키로 실제 결제·환불까지, Toss 키로 인증까지 확인했다.
  PortOne V2·Polar의 공개 server credential은 찾지 못했다.
