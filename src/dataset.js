/**
 * 데이터 로드 · 정규화 · 유효성 검사 · 중복 제거
 *
 * 처리 순서 (문제지 5장)                                              → 이 파일의 위치
 *   1. 파일 읽기   : DATA_DIR/{naver,meta,google}.json                     → 1. loadFeeds
 *                    누락·파싱 실패·배열 아님 → DataFileError (서버 시작 실패, 0건으로 숨기지 않음)
 *   2. 정규화·검증 : 매체별 원본 필드를 공통 구조로 옮기면서 값 검사          → 2. 값 검사, 3. MAPPERS·normalizeRow
 *                    필수값 하나라도 틀리면 그 행 전체 무효 (0으로 보정하지 않음)
 *   3. 무효행 제거 : invalidRows +1 (오류가 여러 개여도 한 번)               → 4. buildDataset
 *   4. 중복 제거   : (platform, date, campaignId) 기준 첫 "유효" 행만 유지 → 4. buildDataset
 *
 * 결과: { rows: 공통 구조 행[], quality: { inputRows, invalidRows, duplicateRows, validRows },
 *         dateRange: { start, end } }  ← 유효 행의 가장 이른·늦은 날짜 (유효 행이 없으면 null). 화면의 빠른 기간 선택용
 * 공통 구조: { date, platform, campaignId, campaignName, impressions, clicks, cost, conversions, revenue }
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';

export const PLATFORMS = ['google', 'meta', 'naver']; // 응답 byPlatform 순서와 동일
export const METRIC_FIELDS = ['impressions', 'clicks', 'cost', 'conversions', 'revenue'];
const MICROS_PER_WON = 1_000_000;

/** 데이터 파일 자체의 문제(누락·JSON 오류·배열 아님). 행 단위 무효와 달리 0건으로 숨기지 않고 시작을 실패시킵니다. */
export class DataFileError extends Error {
  constructor(message, options) {
    super(message, options);
    this.name = 'DataFileError';
  }
}

// =============================================================================
// 1. 파일 읽기
// =============================================================================

/** dataDir의 매체별 JSON 배열을 읽습니다 → { naver: [...], meta: [...], google: [...] } */
export function loadFeeds(dataDir) {
  const feeds = {};
  for (const platform of PLATFORMS) {
    const file = path.join(dataDir, `${platform}.json`);
    let text;
    try {
      text = readFileSync(file, 'utf8');
    } catch (error) {
      throw new DataFileError(`데이터 파일을 읽을 수 없습니다: ${file} (${error.code ?? error.message})`, { cause: error });
    }
    let data;
    try {
      data = JSON.parse(text.replace(/^﻿/, '')); // UTF-8 BOM이 붙어 있어도 읽도록
    } catch (error) {
      throw new DataFileError(`JSON 파싱 실패: ${file} (${error.message})`, { cause: error });
    }
    if (!Array.isArray(data)) throw new DataFileError(`최상위 구조가 배열이 아닙니다: ${file}`);
    feeds[platform] = data;
  }
  return feeds;
}

// =============================================================================
// 2. 값 검사 — 통과하면 정규화된 값, 실패하면 INVALID
// =============================================================================

// 검사 실패 표시. 0·null·undefined는 정상 값이거나 "누락"과 헷갈릴 수 있어 전용 값을 씀
const INVALID = Symbol('invalid');

/** 정확한 YYYY-MM-DD, 2000~2099년, 달력에 실제로 있는 날짜 (2026-02-30 → 무효). 공백 허용 안 함. */
export function isValidDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [y, m, d] = value.split('-').map(Number);
  if (y < 2000 || y > 2099) return false;
  const date = new Date(Date.UTC(y, m - 1, d));
  // 2월 30일을 넣으면 Date가 3월 2일로 넘기므로, 넣은 값과 그대로인지 비교
  return date.getUTCFullYear() === y && date.getUTCMonth() === m - 1 && date.getUTCDate() === d;
}

/**
 * 실적 숫자: 0 이상 안전한 정수.
 * - JSON number: 정수 값이면 허용 (120.0도 JS에서는 120). 음수·소수·NaN 무효
 * - 문자열: 앞뒤 공백 제거 후 숫자 0~9만 ("00120", " 120 " 허용 / "1e3", "1,000", "+1", "1.0", "" 무효)
 * - 그 외(boolean, null, 객체 등) 무효
 * 정규식을 먼저 검사하는 이유: Number("1e3")=1000, Number(" ")=0, parseInt("12x")=12 처럼
 * JS 기본 변환은 문제지 규칙보다 관대해서 그대로 쓰면 무효 값이 통과함
 */
export function parseCount(value) {
  let n;
  if (typeof value === 'number') n = value;
  else if (typeof value === 'string' && /^[0-9]+$/.test(value.trim())) n = Number(value.trim());
  else return INVALID;
  return Number.isSafeInteger(n) && n >= 0 ? n + 0 : INVALID; // + 0: -0을 0으로
}

/** Google cost_micros → 원. 같은 정수 규칙 + 1,000,000의 배수가 아니면(소수 원) 무효 */
export function parseMicrosToWon(value) {
  const micros = parseCount(value);
  if (micros === INVALID || micros % MICROS_PER_WON !== 0) return INVALID;
  return micros / MICROS_PER_WON;
}

/** 캠페인 ID: 앞뒤 공백 제거 후 비어 있지 않은 "문자열". 숫자 타입 ID는 무효. 대소문자 구별(그대로 유지) */
function parseId(value) {
  if (typeof value !== 'string') return INVALID;
  const id = value.trim();
  return id === '' ? INVALID : id;
}

/** 캠페인명: 유일한 선택 필드. 정상 문자열이면 trim, 아니면(누락·null·비문자열·공백뿐) campaignId로 대체 */
function parseName(value, campaignId) {
  if (typeof value === 'string' && value.trim() !== '') return value.trim();
  return campaignId;
}

/** 중첩 필드를 안전하게 꺼냄. 중간이 객체가 아니면 undefined → 해당 필드 무효 처리로 이어짐 */
function pick(obj, ...keys) {
  let cur = obj;
  for (const key of keys) {
    if (cur === null || typeof cur !== 'object' || Array.isArray(cur)) return undefined;
    cur = cur[key];
  }
  return cur;
}

// =============================================================================
// 3. 매체별 매핑 (문제지 3장 표). 매체를 추가할 때는 여기에 블록 하나만 추가
//    실적 숫자는 여기서 바로 검사(parseCount)하고, 날짜·ID·이름은 normalizeRow에서 공통으로 검사합니다.
// =============================================================================

const MAPPERS = {
  naver: (r) => ({
    date: pick(r, 'stat_date'),
    campaignId: pick(r, 'campaign_id'),
    campaignName: pick(r, 'campaign_name'),
    impressions: parseCount(pick(r, 'impressions')),
    clicks: parseCount(pick(r, 'clicks')),
    cost: parseCount(pick(r, 'cost')),
    conversions: parseCount(pick(r, 'conversions')),
    revenue: parseCount(pick(r, 'revenue'))
  }),
  meta: (r) => ({
    date: pick(r, 'date_start'),
    campaignId: pick(r, 'campaign_id'),
    campaignName: pick(r, 'campaign_name'),
    impressions: parseCount(pick(r, 'impressions')),
    clicks: parseCount(pick(r, 'inline_link_clicks')),
    cost: parseCount(pick(r, 'spend')),
    conversions: parseCount(pick(r, 'purchases')),
    revenue: parseCount(pick(r, 'purchase_value'))
  }),
  google: (r) => ({
    date: pick(r, 'segments', 'date'),
    campaignId: pick(r, 'campaign', 'id'),
    campaignName: pick(r, 'campaign', 'name'),
    impressions: parseCount(pick(r, 'metrics', 'impressions')),
    clicks: parseCount(pick(r, 'metrics', 'clicks')),
    cost: parseMicrosToWon(pick(r, 'metrics', 'cost_micros')),
    conversions: parseCount(pick(r, 'metrics', 'conversions')),
    revenue: parseCount(pick(r, 'metrics', 'conversions_value'))
  })
};

/** 원본 한 행 → 공통 구조 한 행. 필수값 중 하나라도 무효면 null */
export function normalizeRow(platform, raw) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const m = MAPPERS[platform](raw);

  const campaignId = parseId(m.campaignId);
  if (!isValidDate(m.date) || campaignId === INVALID) return null;
  if (METRIC_FIELDS.some((field) => m[field] === INVALID)) return null;

  return {
    date: m.date,
    platform,
    campaignId,
    campaignName: parseName(m.campaignName, campaignId),
    impressions: m.impressions,
    clicks: m.clicks,
    cost: m.cost,
    conversions: m.conversions,
    revenue: m.revenue
  };
}

// =============================================================================
// 4. 정규화 → 무효 제거 → 중복 제거
// =============================================================================

/** { naver: [...], meta: [...], google: [...] } → { rows, quality, dateRange } */
export function buildDataset(feeds) {
  const rows = [];
  const seen = new Set(); // 이미 나온 (platform, date, campaignId) 키
  let inputRows = 0;
  let invalidRows = 0;
  let duplicateRows = 0;

  for (const platform of PLATFORMS) {
    for (const raw of feeds[platform] ?? []) {
      inputRows += 1;
      const row = normalizeRow(platform, raw);
      if (!row) {
        invalidRows += 1; // 무효 행은 seen에 등록하지 않음 → 뒤의 유효 행을 막지 않음
        continue;
      }
      // JSON.stringify로 키를 만들어 ID에 구분자 문자가 들어 있어도 서로 섞이지 않게 함
      const key = JSON.stringify([platform, row.date, row.campaignId]);
      if (seen.has(key)) {
        duplicateRows += 1; // 첫 유효 행만 유지, 값이 달라도 이후 행은 제외
        continue;
      }
      seen.add(key);
      rows.push(row);
    }
  }

  // YYYY-MM-DD 문자열은 사전순 = 날짜순이라 문자열 비교로 최소·최대를 구함
  let start = null;
  let end = null;
  for (const { date } of rows) {
    if (start === null || date < start) start = date;
    if (end === null || date > end) end = date;
  }

  return { rows, quality: { inputRows, invalidRows, duplicateRows, validRows: rows.length }, dateRange: { start, end } };
}
