# AQNET 풀스택 개발자 코딩테스트 — 스타터코드

> 이 프로젝트는 가상의 광고 데이터만 사용합니다. 문제지(`261110_개발자코딩테스트_지원자용.docx`)와 함께 제공됩니다.

## 진행 일정

- 과제 전달일: 2026-11-11(수)
- 제출 마감: 2026-11-12(목) 23:59
- 권장 풀이시간: 120분 (과제형이므로 실시간 제한·계측 없음)
- 면접: 2026-11-13(금) 15:00 — 제출 코드 리뷰 및 기술 질문

## 실행

- Node.js 20 이상
- 별도 npm 패키지 설치 불필요
- `npm start` 실행 후 http://localhost:3000 접속
- `npm test`로 테스트 실행
- 정상 초기 상태: `/health`는 응답하고, API 두 개는 HTTP 501을 반환합니다. 지원자가 구현하세요.

## 구현 파일

- `src/analytics.js`: 서로 다른 매체의 데이터를 정규화하고 2개 API 데이터를 생성
- `public/app.js`: 필터 연동, 조회, 테이블 및 요약 표시
- 그 외 파일도 자유롭게 개선 가능

## 공통 데이터 구조

`{date, platform, campaignId, campaignName, impressions, clicks, cost, conversions, revenue}`

- `date`: `YYYY-MM-DD` 날짜, 원본에도 동일한 이름으로 주어집니다.
- `platform`: `naver`/`meta`/`google`
- `campaignId`, `campaignName`: 문자열
- 실적 필드는 모두 number로 정규화. 금액 단위는 원(KRW)
- Google `metrics.cost_micros`는 **1원 = 1,000,000 micros** 로 취급합니다. 시험용 가상 데이터 규칙입니다.
- 같은 매체의 같은 캠페인은 날짜가 달라도 하나의 캠페인으로 집계합니다.

## 필수 API 응답 형식

1. `GET /api/summary` → `{ "totals": Metrics, "byPlatform": [{"platform":"google", ...Metrics}, ...] }`
2. `GET /api/campaigns` → `{ "count": 6, "items": [{"platform":"naver", "campaignId":"N-101", "campaignName":"브랜드 검색 A", ...Metrics}, ...] }`

`Metrics`의 속성은 아래와 같습니다. 모두 숫자이며 분모가 0인 파생 지표는 `null`입니다.

```json
{
  "impressions": 38000,
  "clicks": 980,
  "cost": 420000,
  "conversions": 35,
  "revenue": 1500000,
  "ctr": 2.58,
  "cvr": 3.57,
  "cpc": 428.57,
  "cpa": 12000,
  "roas": 357.14
}
```

- 파생 지표: `CTR=clicks/impressions*100`, `CVR=conversions/clicks*100`, `CPC=cost/clicks`, `CPA=cost/conversions`, `ROAS=revenue/cost*100`
- 집계된 기본 수치로 비율을 계산하고 결과를 소수 둘째 자리 반올림합니다.
- `/api/summary`의 `byPlatform`은 `platform` 오름차순 정렬합니다.
- `/api/campaigns`는 `cost` 내림차순, 동점 시 `platform` → `campaignId` 사전순입니다.
- `start`와 `end`는 선택적이며 날짜 경계 포함; `platform`은 단일 선택 필터입니다.
- 잘못된 쿼리에는 HTTP 400과 `{"error":"INVALID_QUERY", "message":"..."}`로 응답하세요.
- 필터 결과가 비면 기본 수치는 0, 파생 지표는 `null`, `byPlatform`·`items`는 빈 배열입니다.

### 예시

`GET /api/summary?start=2026-11-02&end=2026-11-02&platform=naver`

이 요청의 전체 광고비는 `90000`입니다.

## 응시자 제출 방식

1. 소스코드 폴더를 ZIP으로 압축해 **2026-11-12(목) 23:59**까지 안내받은 이메일로 회신 (node_modules, API 키, 개인정보 제외)
2. 아래에 구현 내용, 미완성 사항, AI 도구 사용 내역, 본인이 작성한 테스트 2개 이상을 기록
3. 제출한 결과를 바탕으로 코드 설명 및 추가 수정 질문이 이어질 수 있습니다.

## 구현 메모 (지원자 작성)

### 실행 방법

```bash
npm start   # http://localhost:3000 (PORT 환경변수로 변경 가능)
npm test    # node:test, 외부 패키지 없음
```

### 구현 내용

**`src/analytics.js`** — 정규화 → 쿼리 검증 → 필터 → 집계 → 파생 지표, 단계별 함수로 분리

- **정규화**: 매체별 필드 매핑을 `MAPPERS` 객체에 모아 두어 매체 추가 시 매퍼 하나만 추가하면 됩니다.
  - Meta 문자열 숫자는 `toNumber()`로 변환(천 단위 콤마 허용). 빈 문자열·`null`·`"abc"` 등 변환 불가 값은 `0`으로 조용히 넘기지 않고 데이터 오류(500)로 처리해 잘못된 집계를 막습니다.
  - Google `cost_micros / 1,000,000`.
  - `server.js`의 feeds는 시작 시 1회 로드되는 불변 객체이므로 정규화 결과를 `WeakMap`에 캐시해 요청마다 재변환하지 않습니다.
- **쿼리 검증** (`parseQuery`): 위반 시 `InvalidQueryError` → 기존 `server.js` 핸들러가 `400 INVALID_QUERY`로 응답
  - 날짜: `YYYY-MM-DD` 정규식 + 실제 달력 날짜 검사(`2026-02-30` 거부)
  - `start > end` 거부, `start == end` 허용
  - `platform`: `naver|meta|google`만 허용(대소문자 구분)
  - 같은 파라미터 중복 지정(`platform=naver&platform=meta`) 거부 — 단일 선택 필터이므로 모호한 요청을 막기 위함
  - 빈 문자열(`platform=`)은 미입력으로 간주 — HTML 폼의 "전체" 옵션 값이 `""`이기 때문
- **집계**: 원본 5개 합계를 먼저 구한 뒤 비율 계산(행별 비율 평균 X). 분모가 0이면 `null`.
  - 반올림은 `round2()`에서 지수 표기 이동(`1.005e2`) 방식으로 처리해 `Math.round(1.005*100)/100 = 1` 같은 부동소수 오차를 피했습니다.
  - 캠페인 키는 `platform + campaignId`. 날짜별로 캠페인명이 다를 경우 가장 최근 날짜의 이름을 사용합니다.
  - 정렬: `cost` 내림차순 → `platform` → `campaignId` 사전순(로케일 무관 코드포인트 비교).
  - `byPlatform`은 필터 결과에 존재하는 매체만 포함(빈 결과면 `[]`).

**`public/app.js`**

- 시작일/종료일/매체 → 쿼리스트링(빈 값 생략) → `/api/summary`, `/api/campaigns` 병렬 호출
- 요약 카드(광고비·전환수·매출·CPA·ROAS), 캠페인 표(매체·캠페인명·광고비·전환·ROAS). `null` 지표는 `-`로 표시
- 로딩 중 버튼 비활성화 + 상태 문구, 서버 오류 메시지(`message`) 그대로 표시, 빈 결과 안내 행
- 연속 클릭 시 `AbortController`로 이전 요청을 취소해 늦게 도착한 응답이 최신 결과를 덮어쓰지 않도록 처리
- 모든 데이터 문자열은 `textContent`/`replaceChildren`으로 렌더링(`innerHTML` 미사용 → XSS 방지)
- 첫 진입 시 전체 조건으로 자동 조회. 시작일 > 종료일은 클라이언트에서도 먼저 안내

**`server.js`** (소폭 수정)

- `server`를 export하고, `node server.js`로 직접 실행할 때만 `listen`하도록 변경 → 테스트에서 임의 포트로 띄워 HTTP 400 응답까지 검증

### 자체 테스트 (`tests/analytics.test.mjs`, 총 26개 + 기존 스모크 1개)

| 영역 | 내용 |
| --- | --- |
| 정규화 | 공통 필드/number 타입, Meta 문자열·Google micros 변환, 숫자 변환 불가 시 오류 |
| summary | 문제지 06 검증값 전체 일치, 매체별 합 = 전체 합, README 예시(광고비 90000), 경계 포함(start만/end만), 빈 결과(0/null/[]), 합계 기반 비율, 빈 문자열 파라미터 |
| campaigns | 6개 캠페인 합산·정렬, 동점 정렬(platform→campaignId), 매체 다른 동일 ID 분리, 분모 0 → null, 빈 결과 |
| 입력 검증 | 형식 오류·존재하지 않는 날짜·한 자리 월·start>end·미허용 매체·대소문자·중복 파라미터 → 400 대상, start==end 허용 |
| HTTP | 실제 서버 기동 후 200 응답, 400 + `INVALID_QUERY` 응답 형식 |

### 미완성/한계

- 데이터는 서버 시작 시 메모리에 로드하는 구조 그대로이며, 대용량 데이터나 DB 연동은 고려하지 않았습니다.
- 날짜는 원본의 `YYYY-MM-DD` 문자열을 그대로 사용하며 타임존 변환은 하지 않습니다(매체별 리포트 기준 타임존이 다를 수 있는 실제 환경에서는 보완 필요).
- 원본 데이터에 숫자가 아닌 값이 있으면 해당 요청 전체가 500이 됩니다. 실서비스라면 행 단위로 격리·로깅하는 정책이 필요합니다.
- 금액은 소수 둘째 자리로 정리해 반환합니다(원 단위 데이터라 현재 영향 없음).
- 프론트엔드 동작은 수동 확인만 했고 브라우저 자동화 테스트는 없습니다.
- 페이지네이션, 정렬 변경, URL 쿼리와 필터 상태 동기화는 구현하지 않았습니다.

### AI 사용 범위

- Claude Code(Claude Opus)를 사용해 요구사항 분석, `src/analytics.js`·`public/app.js`·테스트 코드 초안 작성, README 정리를 진행했습니다.
- 생성된 코드는 문제지 06 검증값·README 예시와 대조하고, `npm test` 및 실제 서버(`curl`)로 200/400 응답을 직접 확인했습니다.
- 설계 판단(빈 문자열 = 미입력, 중복 파라미터 거부, 대소문자 구분, 캠페인명은 최신 날짜 기준, 데이터 오류는 500)은 위에 근거와 함께 적었으며 면접에서 설명할 수 있도록 검토했습니다.
