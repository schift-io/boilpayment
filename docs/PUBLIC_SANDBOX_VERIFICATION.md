# 공식 공개 테스트 키 검증

2026-09-10. 문서에서 의도적으로 공개한 샘플만 사용했다.
키 발견, API 인증, 결제·환불, 실제 webhook 수신은 서로 다른 검증 단계다.

## 공식 출처

- Stripe: [공식 인증 예제](https://docs.stripe.com/api/authentication?api-version=2024-06-20)는
  공용 샘플 키로 예제를 시험할 수 있다고 안내하며 개인정보를 제출하지 말라고 명시한다.
  사용한 키 fingerprint: `sk_test_BQok...2HlWgH4olfQ2`. 키 전체는 이 문서에 복제하지 않는다.
- Toss: [공식 API 키 안내](https://docs.tosspayments.com/reference/using-api/api-keys)와
  [FAQ](https://docs.tosspayments.com/resources/faq)는 로그인 전 문서 테스트 키 사용을 허용한다.
  공식 문서용 `test_sk_...` 샘플을 사용했다. 공개 client key와 서버 secret은 구분한다.
- PortOne V2: [공식 API](https://developers.portone.io/api/rest-v2)와
  [공식 샘플](https://github.com/portone-io/portone-sample/blob/main/fastapi-react/server/__init__.py)을
  확인했다. 재사용 가능한 공개 V2 server secret은 찾지 못했으며 샘플도 `V2_API_SECRET`을 요구한다.
- Polar: [공식 sandbox 안내](https://polar.sh/docs/integrate/sandbox)와
  [인증 안내](https://polar.sh/docs/api-reference/introduction)를 확인했다.
  재사용 가능한 공개 organization token은 찾지 못했다. 테스트 카드 번호는 API 인증 키가 아니다.

## 읽기 전용 인증 확인

다른 사용자의 데이터를 나열하지 않고, 존재하지 않는 거래 ID를 GET 조회했다.

| Provider | 응답 | 입증한 내용 |
|---|---|---|
| Stripe | HTTP 404, invalid_request_error / resource_missing | 공식 샘플 키로 실제 test API 인증 통과 |
| Toss | HTTP 404, NOT_FOUND_PAYMENT | 공식 샘플 키로 실제 API 인증 통과 |

404를 결제 성공으로 세지 않는다. 이 두 검사는 인증 경계만 입증한다.

## Stripe 실제 test API 결제·환불

기존 built `StripeProvider`를 사용했다. 이번 실행에서 만든 synthetic 거래만 대상으로 삼았으며
개인정보·고객 생성·타인 계정 데이터 조회·계정 설정 변경은 하지 않았다.

| 단계 | 관측 결과 |
|---|---|
| 테스트 결제 | `pi_3UE1nw2eZvKYlo2C1Z32dGqs`, succeeded, USD 1000 cents |
| 같은 생성 멱등키 재실행 | 같은 PaymentIntent ID |
| 부분 환불 | `re_3UE1nw2eZvKYlo2C1mk2kCo6`, succeeded, 400 cents |
| 같은 환불 멱등키 재실행 | 같은 Refund ID |
| 잔여분 정리 환불 | `re_3UE1nw2eZvKYlo2C1KN9PYkz`, succeeded, 600 cents |
| 최종 실제 Stripe 조회 | PaymentIntent amount_received=1000; Charge amount_refunded=1000, refunded=true; 환불 두 건 각각400/600 |

중간의 잔여600은 산술 및 후속600 환불로 확인했다. SDK `getPayment`는 원결제 금액을 반환하며
amount_refunded를 노출하지 않아, 최종 완전 환불 상태는 실제 Stripe raw 조회로 확인했다.

## 결제·환불 API 검증 당시 경계

아래는 API 왕복 직후 기록이다. Stripe 로컬 webhook 전달은 뒤의 후속 검증에서 완료했다.

- 이 결과는 실제 Stripe API와 기존 provider 경로의 검증이다. 생성 프로젝트 전체·실제 서명 webhook
  전달까지 통과했다는 뜻은 아니다. provider 생성 시 webhook 인자는 사용하지 않았으며 webhook
  secret 검증·공용 계정의 webhook 설정 변경을 수행하지 않았다.
- Toss는 이번 실행에서 인증만 확인했다. 결제·부분 취소·웹훅 전체 왕복 완료로 표시하지 않는다.
- PortOne V2·Polar는 공식 출처에서 사용 가능한 공개 server credential을 찾지 못했다.
- 앞선 'Stripe는 반드시 계정별 키가 있어야 시작할 수 있다'는 설명을 정정한다. 공식 공개 키로
  실제 결제·환불까지 수행할 수 있었다. 개인 계정 키 미설정과 테스트 불가능을 동일시하지 않는다.

## 후속 검증 — 실제 Stripe 이벤트를 로컬 서버로 전달

동일한 공식 공개 키로 수행했다. 공식 Stripe CLI `v1.50.10` macOS arm64 실행 파일을
임시 폴더에서 사용하고 공식 checksum과 대조했다.
SHA-256: `29f7d7ead27625a04bd860aceb5fbdbee93a30b8c5338deba2952a821ac1b8fe`.
설치·로그인·공유 Dashboard webhook endpoint·공개 tunnel 없이 명시적 `--api-key`와
`stripe listen --forward-to`를 사용했다. [공식 로컬 전달 절차](https://docs.stripe.com/webhooks?lang=node).

새 synthetic PaymentIntent `pi_3UE1zT2eZvKYlo2C0mZrYg7j`를 USD 1000 cents로 생성했다.
수신기는 task metadata와 해당 payment reference로 이번 거래만 처리했다.

| 실제 전달 이벤트 | 결과 |
|---|---|
| `evt_3UE1zT2eZvKYlo2C0cQfIGg9` — payment_intent.succeeded | Kit 서명 검증 PASS, receive 200, process processed, normalized payment.succeeded |
| `evt_3UE1zT2eZvKYlo2C0Cgag61C` — refund.created | 환불400 cents, refundRef=`re_3UE1zT2eZvKYlo2C0Bonx0gK`, 서명 검증 PASS, receive200, process processed |
| `evt_3UE1zT2eZvKYlo2C0K2Cy6yX` — refund.created | 정리 환불600 cents, refundRef=`re_3UE1zT2eZvKYlo2C0a7YBMju`, 서명 검증 PASS, receive200, process processed |

400 환불의 같은 멱등키 재실행은 같은 Refund ID를 반환했다.
최종 실제 Stripe 조회는 amount_received=1000, amount_refunded=1000, refunded=true였다.
임시 실행 파일·로그·listener·receiver를 정리했다. webhook signing secret은 저장소에 기록하지 않았다.

CLI 로그에는 refund.updated도 있었으나 수신기에서 같은 환불 ID의 중복을 별도로 기록하지 않았다.
따라서 실제 pending→succeeded/failed 상태 전환까지 검증했다는 뜻은 아니다. 이번 증거는
실제 Stripe 이벤트→공식 CLI 전달→로컬 Kit 서명·수신·처리 경로이며, Dashboard endpoint로
직접 보내는 전달이나 생성 프로젝트 전체의 금전 처리까지 입증하는 것은 아니다.

기존 `boilpayment live`의 listen/trigger가 전역 CLI 계정을 사용할 수 있던 경로도 수정했다.
두 subprocess 모두 선택한 STRIPE_SECRET_KEY를 명시한다. 키 바인딩을 포함한 CLI live 테스트
27개와 TypeScript typecheck가 통과했다.
