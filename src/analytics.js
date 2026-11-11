// 광고 매체별 원본 데이터를 공통 구조로 정규화하고, 기간/매체 필터에 따라 집계합니다.
// 공통 구조: { date, platform, campaignId, campaignName, impressions, clicks, cost, conversions, revenue }

export class InvalidQueryError extends Error {
  constructor(message) { super(message); this.name = 'InvalidQueryError'; }
}

export const PLATFORMS = Object.freeze(['naver', 'meta', 'google']);
const BASE_FIELDS = Object.freeze(['impressions', 'clicks', 'cost', 'conversions', 'revenue']);
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const MICROS_PER_WON = 1_000_000; // 시험용 정의: 1원 = 1,000,000 micros

// ---------------------------------------------------------------------------
// 1. 정규화
// ---------------------------------------------------------------------------

/** 숫자 또는 숫자 문자열("1,000" 포함)을 number로 변환. 변환 불가 시 데이터 오류로 간주합니다. */
function toNumber(value, context) {
  const n = typeof value === 'string' ? Number(value.replace(/,/g, '').trim()) : value;
  if (typeof n !== 'number' || !Number.isFinite(n) || (typeof value === 'string' && value.trim() === '')) {
    throw new Error(`데이터 형식 오류: ${context} 값이 숫자가 아닙니다 (${JSON.stringify(value)})`);
  }
  return n;
}

// 매체별 원본 필드 → 공통 필드 매핑. 새 매체는 여기에 추가하면 됩니다.
const MAPPERS = {
  naver: (r) => ({
    campaignId: r.campaign_id, campaignName: r.campaign_name,
    impressions: r.impressions, clicks: r.clicks, cost: r.cost,
    conversions: r.conversions, revenue: r.revenue
  }),
  meta: (r) => ({
    campaignId: r.campaignId, campaignName: r.name,
    impressions: r.impressions, clicks: r.link_clicks, cost: r.spend,
    conversions: r.purchases, revenue: r.purchase_value
  }),
  google: (r) => {
    const m = r.metrics ?? {};
    return {
      campaignId: r.id, campaignName: r.campaign,
      impressions: m.impressions, clicks: m.clicks,
      cost: toNumber(m.cost_micros, 'google.metrics.cost_micros') / MICROS_PER_WON,
      conversions: m.conversions, revenue: m.conversion_value
    };
  }
};

export function normalizeRow(platform, raw) {
  const mapper = MAPPERS[platform];
  if (!mapper) throw new Error(`지원하지 않는 매체입니다: ${platform}`);
  const mapped = mapper(raw);
  const row = {
    date: String(raw.date),
    platform,
    campaignId: String(mapped.campaignId),
    campaignName: String(mapped.campaignName ?? '')
  };
  if (!isValidDate(row.date)) throw new Error(`데이터 형식 오류: ${platform} 날짜가 올바르지 않습니다 (${raw.date})`);
  for (const field of BASE_FIELDS) row[field] = toNumber(mapped[field], `${platform}.${field}`);
  return row;
}

export function normalizeFeeds(feeds) {
  const rows = [];
  for (const platform of PLATFORMS) {
    for (const raw of feeds?.[platform] ?? []) rows.push(normalizeRow(platform, raw));
  }
  return rows;
}

// server.js의 feeds는 시작 시 한 번 로드되는 불변 객체이므로 정규화 결과를 캐시합니다.
const normalizedCache = new WeakMap();
function getRows(feeds) {
  if (!normalizedCache.has(feeds)) normalizedCache.set(feeds, normalizeFeeds(feeds));
  return normalizedCache.get(feeds);
}

// ---------------------------------------------------------------------------
// 2. 쿼리 검증
// ---------------------------------------------------------------------------

/** YYYY-MM-DD 형식이면서 실제 존재하는 날짜인지 확인 (예: 2026-02-30 거부). */
function isValidDate(value) {
  if (!DATE_RE.test(value)) return false;
  const [y, m, d] = value.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

/** 단일 값 파라미터를 꺼냅니다. 빈 문자열은 '미입력'으로 처리하고, 중복 지정은 거부합니다. */
function getSingle(params, name) {
  const values = params.getAll(name);
  if (values.length > 1) throw new InvalidQueryError(`${name} 파라미터는 한 번만 지정할 수 있습니다.`);
  const value = values[0]?.trim();
  return value ? value : undefined;
}

export function parseQuery(searchParams) {
  const params = searchParams instanceof URLSearchParams
    ? searchParams
    : new URLSearchParams(searchParams ?? '');
  const start = getSingle(params, 'start');
  const end = getSingle(params, 'end');
  const platform = getSingle(params, 'platform');

  for (const [name, value] of [['start', start], ['end', end]]) {
    if (value !== undefined && !isValidDate(value)) {
      throw new InvalidQueryError(`${name}는 YYYY-MM-DD 형식의 유효한 날짜여야 합니다: ${value}`);
    }
  }
  if (start && end && start > end) {
    throw new InvalidQueryError(`start(${start})는 end(${end})보다 늦을 수 없습니다.`);
  }
  if (platform !== undefined && !PLATFORMS.includes(platform)) {
    throw new InvalidQueryError(`platform은 ${PLATFORMS.join(', ')} 중 하나여야 합니다: ${platform}`);
  }
  return { start, end, platform };
}

function filterRows(rows, { start, end, platform }) {
  // YYYY-MM-DD는 사전순 비교 = 날짜순 비교. 양쪽 경계 포함.
  return rows.filter((r) =>
    (!start || r.date >= start) &&
    (!end || r.date <= end) &&
    (!platform || r.platform === platform));
}

// ---------------------------------------------------------------------------
// 3. 집계 및 파생 지표
// ---------------------------------------------------------------------------

/** 소수 둘째 자리 반올림. 지수 표기 이동으로 1.005 같은 부동소수 오차를 피합니다. */
export function round2(value) {
  return Number(`${Math.round(Number(`${value}e2`))}e-2`);
}

/** 분모가 0(또는 없음)이면 null, 아니면 반올림된 비율. */
function ratio(numerator, denominator, multiplier = 1) {
  if (!denominator) return null;
  return round2((numerator / denominator) * multiplier);
}

function emptyTotals() {
  return Object.fromEntries(BASE_FIELDS.map((f) => [f, 0]));
}

function addInto(target, row) {
  for (const f of BASE_FIELDS) target[f] += row[f];
  return target;
}

/** 원본 합계로부터 파생 지표를 계산합니다 (행별 비율의 평균이 아님). */
export function withMetrics(totals) {
  const t = {};
  // 부동소수 누적 오차(예: 0.1+0.2) 정리용. 원 단위 금액은 소수 둘째 자리면 충분합니다.
  for (const f of BASE_FIELDS) t[f] = round2(totals[f]);
  return {
    ...t,
    ctr: ratio(t.clicks, t.impressions, 100),
    cvr: ratio(t.conversions, t.clicks, 100),
    cpc: ratio(t.cost, t.clicks),
    cpa: ratio(t.cost, t.conversions),
    roas: ratio(t.revenue, t.cost, 100)
  };
}

// ---------------------------------------------------------------------------
// 4. API
// ---------------------------------------------------------------------------

export function getSummary(feeds, searchParams) {
  const query = parseQuery(searchParams);
  const rows = filterRows(getRows(feeds), query);

  const totals = emptyTotals();
  const byPlatform = new Map();
  for (const row of rows) {
    addInto(totals, row);
    if (!byPlatform.has(row.platform)) byPlatform.set(row.platform, emptyTotals());
    addInto(byPlatform.get(row.platform), row);
  }

  return {
    totals: withMetrics(totals),
    byPlatform: [...byPlatform.entries()]
      .sort(([a], [b]) => compareStr(a, b))
      .map(([platform, sums]) => ({ platform, ...withMetrics(sums) }))
  };
}

export function getCampaigns(feeds, searchParams) {
  const query = parseQuery(searchParams);
  const rows = filterRows(getRows(feeds), query);

  // 캠페인 식별 키: platform + campaignId
  const campaigns = new Map();
  for (const row of rows) {
    const key = `${row.platform}\u0000${row.campaignId}`;
    let c = campaigns.get(key);
    if (!c) {
      c = { platform: row.platform, campaignId: row.campaignId, campaignName: row.campaignName, lastDate: row.date, sums: emptyTotals() };
      campaigns.set(key, c);
    }
    // 날짜별로 캠페인명이 다르면 가장 최근 날짜의 이름을 사용합니다.
    if (row.date >= c.lastDate) { c.campaignName = row.campaignName; c.lastDate = row.date; }
    addInto(c.sums, row);
  }

  const items = [...campaigns.values()]
    .map((c) => ({ platform: c.platform, campaignId: c.campaignId, campaignName: c.campaignName, ...withMetrics(c.sums) }))
    .sort((a, b) =>
      (b.cost - a.cost) ||
      compareStr(a.platform, b.platform) ||
      compareStr(a.campaignId, b.campaignId));

  return { count: items.length, items };
}

// 로케일과 무관한 코드포인트 기준 사전순 비교
function compareStr(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}
