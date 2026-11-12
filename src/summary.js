/**
 * GET /api/summary · /api/campaigns 의 쿼리 검증 · 필터 · 집계 · 지표 계산
 *
 * 처리 순서: 쿼리 검증 → 필터(기간·매체) → 합계 → 파생 지표(합계로 계산 후 마지막에 반올림)
 *   1. parseQuery  : 잘못된 조건이면 InvalidQueryError → server.js가 400으로 응답
 *   2. ratio·toMetrics : 합계 → CTR·CPC·CPA·ROAS
 *   3. getSummary  : 전체·매체별(필수) + 날짜별(byDate, 화면 그래프용 추가 키)
 *      getCampaigns: 캠페인별 (선택 심화)
 * 입력 dataset은 src/dataset.js buildDataset()의 결과(무효·중복 제거 완료)입니다.
 */
import { PLATFORMS, METRIC_FIELDS, isValidDate } from './dataset.js';

/** 잘못된 조회 조건. server.js가 잡아서 400 { error: 'INVALID_QUERY', message }로 응답합니다. */
export class InvalidQueryError extends Error {
  constructor(message) {
    super(message);
    this.name = 'InvalidQueryError';
  }
}

// =============================================================================
// 1. 쿼리 검증
// =============================================================================

const FILTER_KEYS = ['start', 'end', 'platform'];

/**
 * URLSearchParams → { start, end, platform } (미입력은 undefined)
 * - 같은 필터 키가 두 번 이상 → 400 (값이 비어 있어도)
 * - 빈 문자열 = 미입력 / 공백 문자열(" ")은 미입력이 아니라 잘못된 값 → 400 (trim 하지 않음)
 * - start / end / platform 외의 키는 무시
 */
export function parseQuery(searchParams) {
  const query = {};
  for (const key of FILTER_KEYS) {
    const values = searchParams.getAll(key);
    if (values.length > 1) throw new InvalidQueryError(`${key} 파라미터는 한 번만 지정할 수 있습니다.`);
    query[key] = values[0] === undefined || values[0] === '' ? undefined : values[0];
  }

  const { start, end, platform } = query;
  if (start !== undefined && !isValidDate(start)) {
    throw new InvalidQueryError(`start는 2000~2099년의 유효한 YYYY-MM-DD 날짜여야 합니다: "${start}"`);
  }
  if (end !== undefined && !isValidDate(end)) {
    throw new InvalidQueryError(`end는 2000~2099년의 유효한 YYYY-MM-DD 날짜여야 합니다: "${end}"`);
  }
  if (start !== undefined && end !== undefined && start > end) {
    throw new InvalidQueryError(`start(${start})는 end(${end})보다 늦을 수 없습니다.`);
  }
  if (platform !== undefined && !PLATFORMS.includes(platform)) {
    throw new InvalidQueryError(`platform은 naver, meta, google 중 하나여야 합니다: "${platform}"`);
  }
  return query;
}

// =============================================================================
// 2. 지표 계산
// =============================================================================

/**
 * numerator ÷ denominator × multiplier 를 소수 둘째 자리 사사오입(half up). 분모 0이면 null.
 *
 * 부동소수점으로 나눈 뒤 반올림하면 1.005가 1.00499...로 저장되어 1.00이 되는 문제가 있어,
 * 정수 합계끼리의 나눗셈을 BigInt 정수 연산으로 정확하게 반올림합니다.
 *   round(n/d × m × 100) half up = floor((2·n·m·100 + d) / (2·d))
 * 입력(합계)이 0 이상의 정수라서 가능한 방식이며, 음수는 다루지 않습니다(입력 단계에서 제외).
 */
export function ratio(numerator, denominator, multiplier = 1) {
  if (denominator === 0) return null;
  const n = BigInt(numerator) * BigInt(multiplier) * 100n;
  const d = BigInt(denominator);
  const hundredths = (2n * n + d) / (2n * d); // BigInt 나눗셈은 버림 = floor (양수)
  return Number(hundredths) / 100;
}

/** 기본 합계 5종이 모두 0인 객체 */
function emptySums() {
  return { impressions: 0, clicks: 0, cost: 0, conversions: 0, revenue: 0 };
}

/** 기본 합계 5종(정수 그대로) + 파생 지표 4종. 행별 비율의 평균이 아니라 합계끼리 계산 */
function toMetrics(s) {
  return {
    ...s,
    ctr: ratio(s.clicks, s.impressions, 100), // %
    cpc: ratio(s.cost, s.clicks),             // 원
    cpa: ratio(s.cost, s.conversions),        // 원
    roas: ratio(s.revenue, s.cost, 100)       // %
  };
}

// =============================================================================
// 3. 응답 만들기
// =============================================================================

/** 쿼리 검증 후 기간(양쪽 경계 포함)·매체 조건에 맞는 행만 반환. YYYY-MM-DD 문자열은 사전순 비교 = 날짜순 비교 */
function filterRows(dataset, searchParams) {
  const { start, end, platform } = parseQuery(searchParams);
  return dataset.rows.filter((r) =>
    (start === undefined || r.date >= start) &&
    (end === undefined || r.date <= end) &&
    (platform === undefined || r.platform === platform));
}

/** GET /api/summary — dataset + URLSearchParams → 응답 객체. 쿼리가 잘못되면 InvalidQueryError */
export function getSummary(dataset, searchParams) {
  const matched = filterRows(dataset, searchParams);

  const totals = emptySums();
  const byPlatform = new Map(); // 유효 행이 있는 매체만 들어감 (0원 행만 있어도 포함)
  const byDate = new Map();     // 날짜별 합계 (화면의 일별 추이 그래프용)
  for (const row of matched) {
    if (!byPlatform.has(row.platform)) byPlatform.set(row.platform, emptySums());
    if (!byDate.has(row.date)) byDate.set(row.date, emptySums());
    const sums = byPlatform.get(row.platform);
    const daily = byDate.get(row.date);
    for (const field of METRIC_FIELDS) {
      totals[field] += row[field];
      sums[field] += row[field];
      daily[field] += row[field];
    }
  }

  return {
    totals: toMetrics(totals),
    byPlatform: PLATFORMS // google → meta → naver 고정 순서
      .filter((p) => byPlatform.has(p))
      .map((p) => ({ platform: p, ...toMetrics(byPlatform.get(p)) })),
    quality: { ...dataset.quality, matchedRows: matched.length },
    // 추가 키(계약상 허용): 필터와 무관한 전체 유효 데이터의 기간. 화면이 날짜를 하드코딩하지 않고 빠른 기간 선택에 사용
    dataRange: dataset.dateRange,
    // 추가 키(계약상 허용): 현재 필터 결과의 날짜별 합계·지표, 날짜 오름차순. 데이터가 있는 날짜만 포함
    byDate: [...byDate.keys()].sort().map((date) => ({ date, ...toMetrics(byDate.get(date)) }))
  };
}

/**
 * GET /api/campaigns (선택 심화: 캠페인 상세) — 같은 쿼리 규칙·필터로 캠페인별 합계와 지표
 * → { count, items: [{ platform, campaignId, campaignName, ...Metrics }] }
 *
 * - 캠페인 구분: (platform, campaignId). 같은 ID라도 매체가 다르면 다른 캠페인, 날짜가 달라도 하나로 합산
 * - 캠페인명: 날짜별로 다를 수 있어 "가장 최근 날짜의 실제 이름"을 사용.
 *   이름이 비어 ID로 대체된 행보다 실제 이름이 있는 행을 우선 (모두 없으면 ID)
 * - 정렬: 광고비 내림차순 → platform → campaignId (동점이어도 순서가 항상 같도록)
 */
export function getCampaigns(dataset, searchParams) {
  const campaigns = new Map(); // JSON 키 [platform, campaignId] → { platform, campaignId, name, nameDate, sums }
  for (const row of filterRows(dataset, searchParams)) {
    const key = JSON.stringify([row.platform, row.campaignId]);
    if (!campaigns.has(key)) {
      campaigns.set(key, { platform: row.platform, campaignId: row.campaignId, name: row.campaignId, nameDate: '', sums: emptySums() });
    }
    const c = campaigns.get(key);
    const hasRealName = row.campaignName !== row.campaignId;
    if (hasRealName && row.date >= c.nameDate) {
      c.name = row.campaignName;
      c.nameDate = row.date;
    }
    for (const field of METRIC_FIELDS) c.sums[field] += row[field];
  }

  const byText = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
  const items = [...campaigns.values()]
    .map((c) => ({ platform: c.platform, campaignId: c.campaignId, campaignName: c.name, ...toMetrics(c.sums) }))
    .sort((a, b) => (b.cost - a.cost) || byText(a.platform, b.platform) || byText(a.campaignId, b.campaignId));

  return { count: items.length, items };
}
