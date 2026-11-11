/**
 * 광고 데이터 통합 분석 모듈
 *
 * 처리 흐름 (두 API 공통)
 *   1. 정규화  : 매체마다 다른 원본 필드를 공통 구조로 변환
 *   2. 쿼리 검증: start / end / platform 값 확인, 잘못되면 InvalidQueryError → HTTP 400
 *   3. 필터    : 기간·매체 조건에 맞는 행만 남김
 *   4. 집계    : 원본 합계를 먼저 구하고 → 비율 지표(CTR·CVR·CPC·CPA·ROAS) 계산
 *   5. 정렬    : summary는 매체명 오름차순, campaigns는 광고비 내림차순
 *
 * 공통 구조: { date, platform, campaignId, campaignName, impressions, clicks, cost, conversions, revenue }
 */

/** 잘못된 조회 조건. server.js가 이 에러를 잡아 400 { error: 'INVALID_QUERY', message }로 응답합니다. */
export class InvalidQueryError extends Error {
  constructor(message) {
    super(message);
    this.name = 'InvalidQueryError';
  }
}

const PLATFORMS = ['naver', 'meta', 'google'];                                  // 허용 매체
const BASE_FIELDS = ['impressions', 'clicks', 'cost', 'conversions', 'revenue']; // 합산하는 기본 지표 5종
const MICROS_PER_WON = 1_000_000;                                                 // 시험용 정의: 1원 = 1,000,000 micros

// =============================================================================
// 1. 정규화
// =============================================================================

/**
 * 매체별 원본 필드 → 공통 필드 매핑표.
 * 매체를 추가할 때는 여기에 매퍼 하나만 추가하면 됩니다.
 */
const MAPPERS = {
  naver: (r) => ({
    campaignId: r.campaign_id,
    campaignName: r.campaign_name,
    impressions: r.impressions,
    clicks: r.clicks,
    cost: r.cost,
    conversions: r.conversions,
    revenue: r.revenue
  }),
  // Meta는 숫자가 문자열("8000")로 오므로 아래 toNumber()에서 number로 바뀝니다.
  meta: (r) => ({
    campaignId: r.campaignId,
    campaignName: r.name,
    impressions: r.impressions,
    clicks: r.link_clicks,
    cost: r.spend,
    conversions: r.purchases,
    revenue: r.purchase_value
  }),
  // Google은 지표가 metrics 안에 있고, 광고비가 micros 단위입니다.
  google: (r) => ({
    campaignId: r.id,
    campaignName: r.campaign,
    impressions: r.metrics?.impressions,
    clicks: r.metrics?.clicks,
    cost: toNumber(r.metrics?.cost_micros, 'google.cost_micros') / MICROS_PER_WON,
    conversions: r.metrics?.conversions,
    revenue: r.metrics?.conversion_value
  })
};

/**
 * 숫자 또는 숫자 문자열을 number로 바꿉니다. ("1,000"처럼 콤마가 있어도 허용)
 * 숫자로 바꿀 수 없으면(빈 값, "abc", null) 0으로 넘기지 않고 에러를 냅니다.
 * → 잘못된 데이터가 조용히 0으로 합산되어 합계가 틀어지는 것을 막기 위함 (서버는 500 응답)
 */
function toNumber(value, field) {
  const n = typeof value === 'string' && value.trim() !== ''
    ? Number(value.replace(/,/g, ''))
    : value;
  if (typeof n !== 'number' || !Number.isFinite(n)) {
    throw new Error(`데이터 형식 오류: ${field} 값이 숫자가 아닙니다 (${JSON.stringify(value)})`);
  }
  return n;
}

/** 원본 한 행 → 공통 구조 한 행 */
function normalizeRow(platform, raw) {
  const mapped = MAPPERS[platform](raw);
  const row = {
    date: String(raw.date),
    platform,
    campaignId: String(mapped.campaignId),
    campaignName: String(mapped.campaignName ?? '')
  };
  if (!isValidDate(row.date)) {
    throw new Error(`데이터 형식 오류: ${platform} 날짜가 올바르지 않습니다 (${raw.date})`);
  }
  for (const field of BASE_FIELDS) {
    row[field] = toNumber(mapped[field], `${platform}.${field}`);
  }
  return row;
}

/** { naver: [...], meta: [...], google: [...] } → 공통 구조 행 배열 하나 */
export function normalizeFeeds(feeds) {
  const rows = [];
  for (const platform of PLATFORMS) {
    for (const raw of feeds[platform] ?? []) rows.push(normalizeRow(platform, raw));
  }
  return rows;
}

// server.js의 데이터는 서버 시작 시 한 번 읽고 바뀌지 않으므로,
// 정규화 결과를 저장해 두고 요청마다 다시 변환하지 않습니다.
// (WeakMap: 데이터 객체가 사라지면 캐시도 함께 정리됨)
const cache = new WeakMap();
function getRows(feeds) {
  if (!cache.has(feeds)) cache.set(feeds, normalizeFeeds(feeds));
  return cache.get(feeds);
}

// =============================================================================
// 2. 쿼리 검증
// =============================================================================

/** YYYY-MM-DD 형식이면서 달력에 실제로 있는 날짜인지 확인 (예: 2026-02-30 → false) */
function isValidDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [y, m, d] = value.split('-').map(Number);
  const date = new Date(Date.UTC(y, m - 1, d));
  // 2월 30일을 넣으면 Date가 3월 2일로 넘겨 버리므로, 넣은 값과 그대로인지 비교
  return date.getUTCFullYear() === y && date.getUTCMonth() === m - 1 && date.getUTCDate() === d;
}

/**
 * 쿼리 파라미터 하나를 꺼냅니다.
 * - 같은 이름이 두 번 오면 400 (예: platform=naver&platform=meta → 의도가 모호함)
 * - 빈 문자열은 '미입력'으로 처리 (화면의 "전체" 선택 값이 빈 문자열이기 때문)
 */
function getParam(params, name) {
  const values = params.getAll(name);
  if (values.length > 1) throw new InvalidQueryError(`${name} 파라미터는 한 번만 지정할 수 있습니다.`);
  const value = values[0]?.trim();
  return value || undefined;
}

/** start / end / platform을 꺼내 검증합니다. 문제가 있으면 InvalidQueryError를 던집니다. */
function parseQuery(searchParams) {
  const params = new URLSearchParams(searchParams);
  const start = getParam(params, 'start');
  const end = getParam(params, 'end');
  const platform = getParam(params, 'platform');

  if (start && !isValidDate(start)) throw new InvalidQueryError(`start는 YYYY-MM-DD 형식의 유효한 날짜여야 합니다: ${start}`);
  if (end && !isValidDate(end)) throw new InvalidQueryError(`end는 YYYY-MM-DD 형식의 유효한 날짜여야 합니다: ${end}`);
  if (start && end && start > end) throw new InvalidQueryError(`start(${start})는 end(${end})보다 늦을 수 없습니다.`);
  if (platform && !PLATFORMS.includes(platform)) {
    throw new InvalidQueryError(`platform은 ${PLATFORMS.join(', ')} 중 하나여야 합니다: ${platform}`);
  }
  return { start, end, platform };
}

// =============================================================================
// 3. 필터
// =============================================================================

/** 기간(양쪽 날짜 포함)·매체 조건에 맞는 행만 남깁니다. 조건이 없으면 전체. */
function filterRows(rows, { start, end, platform }) {
  // YYYY-MM-DD 문자열은 글자 순서 비교가 곧 날짜 순서 비교입니다.
  return rows.filter((r) =>
    (!start || r.date >= start) &&
    (!end || r.date <= end) &&
    (!platform || r.platform === platform));
}

// =============================================================================
// 4. 집계 · 파생 지표
// =============================================================================

/**
 * 소수 둘째 자리 반올림.
 * Math.round(1.005 * 100) / 100 은 1이 나옵니다 (1.005가 내부적으로 1.00499...로 저장되기 때문).
 * 그래서 문자열 지수 표기로 자릿수를 옮긴 뒤 반올림합니다: "1.005e2" → 100.5 → 101 → "101e-2" → 1.01
 */
export function round2(value) {
  return Number(`${Math.round(Number(`${value}e2`))}e-2`);
}

/** 비율 계산. 분모가 0이면 null (문제지 규칙) */
function ratio(numerator, denominator, multiplier = 1) {
  if (!denominator) return null;
  return round2((numerator / denominator) * multiplier);
}

/** 기본 지표 5종이 모두 0인 합계 객체 */
function emptyTotals() {
  return { impressions: 0, clicks: 0, cost: 0, conversions: 0, revenue: 0 };
}

/** 행 하나의 기본 지표를 합계에 더합니다. */
function addInto(totals, row) {
  for (const field of BASE_FIELDS) totals[field] += row[field];
}

/**
 * 합계 → 응답용 지표 객체 (기본 5종 + 파생 5종)
 * 중요: 비율은 "합계끼리" 나눕니다. 행별 비율을 구해 평균 내지 않습니다. (문제지 04)
 */
function toMetrics(totals) {
  const t = {};
  for (const field of BASE_FIELDS) t[field] = round2(totals[field]); // 소수 합산 오차(0.1+0.2) 정리
  return {
    ...t,
    ctr: ratio(t.clicks, t.impressions, 100),  // 클릭률(%)
    cvr: ratio(t.conversions, t.clicks, 100),  // 전환율(%)
    cpc: ratio(t.cost, t.clicks),              // 클릭당 비용(원)
    cpa: ratio(t.cost, t.conversions),         // 전환당 비용(원)
    roas: ratio(t.revenue, t.cost, 100)        // 광고비 대비 매출(%)
  };
}

/** 언어 설정과 무관한 사전순 비교 (정렬 결과가 환경마다 달라지지 않도록) */
function compareText(a, b) {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

// =============================================================================
// 5. API — server.js에서 호출
// =============================================================================

/**
 * GET /api/summary
 * → { totals: 전체 지표, byPlatform: [매체별 지표 (매체명 오름차순)] }
 */
export function getSummary(feeds, searchParams) {
  const rows = filterRows(getRows(feeds), parseQuery(searchParams));

  const totals = emptyTotals();
  const byPlatform = new Map(); // 매체명 → 합계
  for (const row of rows) {
    addInto(totals, row);
    if (!byPlatform.has(row.platform)) byPlatform.set(row.platform, emptyTotals());
    addInto(byPlatform.get(row.platform), row);
  }

  return {
    totals: toMetrics(totals),
    byPlatform: [...byPlatform]
      .sort(([a], [b]) => compareText(a, b))
      .map(([platform, sums]) => ({ platform, ...toMetrics(sums) }))
  };
}

/**
 * GET /api/campaigns
 * → { count: 캠페인 수, items: [캠페인별 지표] }
 * 캠페인은 platform + campaignId로 구분하고, 날짜가 달라도 하나로 합산합니다.
 * 정렬: 광고비 내림차순 → 동점이면 platform → campaignId 사전순
 */
export function getCampaigns(feeds, searchParams) {
  const rows = filterRows(getRows(feeds), parseQuery(searchParams));

  const campaigns = new Map(); // "platform:campaignId" → 캠페인 합계
  for (const row of rows) {
    const key = `${row.platform}:${row.campaignId}`;
    if (!campaigns.has(key)) {
      campaigns.set(key, { platform: row.platform, campaignId: row.campaignId, campaignName: row.campaignName, lastDate: row.date, sums: emptyTotals() });
    }
    const c = campaigns.get(key);
    // 날짜별로 캠페인명이 다르면 가장 최근 날짜의 이름을 사용
    if (row.date >= c.lastDate) {
      c.campaignName = row.campaignName;
      c.lastDate = row.date;
    }
    addInto(c.sums, row);
  }

  const items = [...campaigns.values()]
    .map((c) => ({ platform: c.platform, campaignId: c.campaignId, campaignName: c.campaignName, ...toMetrics(c.sums) }))
    .sort((a, b) =>
      (b.cost - a.cost) ||                        // 1순위: 광고비 내림차순
      compareText(a.platform, b.platform) ||      // 2순위: 매체 사전순
      compareText(a.campaignId, b.campaignId));   // 3순위: 캠페인 ID 사전순

  return { count: items.length, items };
}
