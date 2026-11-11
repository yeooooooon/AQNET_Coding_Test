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

- 구현 내용:
- 자체 테스트:
- 미완성/한계:
- AI 사용 범위:
