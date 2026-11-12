/**
 * 캠페인 실적 화면 (검색 · ROAS 기준 필터 · 정렬)
 * 집계는 서버(/api/campaigns)가 하고, 화면은 받은 목록 안에서 걸러 보기·순서 바꾸기만 합니다.
 */
import { navCampaignCount, campaignTable, campaignBody, campaignFoot, campaignCaption, toolbarInfo, searchInput, campaignCsvBtn } from './elements.js';
import { state } from './state.js';
import { el, platformBadge } from './util.js';
import { readForm, load } from './query.js';
import { metricCells } from './overview.js';

/** 캠페인 표의 숫자 열 7개 (index.html thead 순서와 같음) */
export const CAMPAIGN_COLUMNS = ['cost', 'impressions', 'clicks', 'conversions', 'revenue', 'cpa', 'roas'];

/**
 * ROAS 기준 필터 (운영 기준 가정 — 데이터에서 나온 값이 아님, 여기 상수만 바꾸면 됨)
 * 우수: 450% 이상 / 양호: 350% 이상 450% 미만 / 주의: 350% 미만
 * ROAS를 계산할 수 없는 캠페인(광고비 0원 → null)은 "전체"에서만 보임
 */
export const ROAS_BANDS = { high: 450, low: 350 };

export const inBand = (c, band) => {
  if (band === 'all') return true;
  if (c.roas === null) return false;
  if (band === 'high') return c.roas >= ROAS_BANDS.high;
  if (band === 'low') return c.roas < ROAS_BANDS.low;
  return c.roas >= ROAS_BANDS.low && c.roas < ROAS_BANDS.high; // mid
};

export const SORT_LABELS = { campaignName: '캠페인명', cost: '광고비', impressions: '노출', clicks: '클릭', conversions: '전환수', revenue: '전환 매출', cpa: 'CPA', roas: 'ROAS' };

/** 정렬 비교. null(계산 불가)은 방향과 관계없이 항상 맨 아래 */
export function compareBy(key, dir) {
  return (a, b) => {
    const av = a[key];
    const bv = b[key];
    if (av === null && bv === null) return 0;
    if (av === null) return 1;
    if (bv === null) return -1;
    const diff = typeof av === 'number' ? av - bv : String(av).localeCompare(String(bv), 'ko');
    return dir === 'asc' ? diff : -diff;
  };
}

/** 서버와 같은 규칙의 비율: 정수 합계끼리 나눠 소수 둘째 자리 사사오입, 분모 0이면 null (검색 결과 합계 행용) */
export function ratio(numerator, denominator, multiplier = 1) {
  if (denominator === 0) return null;
  const n = BigInt(numerator) * BigInt(multiplier) * 100n;
  const d = BigInt(denominator);
  return Number((2n * n + d) / (2n * d)) / 100;
}

/** 보이는 캠페인들의 합계 + 지표 (검색·필터 중 합계 행용, 서버와 같은 계산 규칙) */
export function sumMetrics(rows) {
  const s = { impressions: 0, clicks: 0, cost: 0, conversions: 0, revenue: 0 };
  for (const row of rows) for (const key of Object.keys(s)) s[key] += row[key];
  return { ...s, ctr: ratio(s.clicks, s.impressions, 100), cpc: ratio(s.cost, s.clicks), cpa: ratio(s.cost, s.conversions), roas: ratio(s.revenue, s.cost, 100) };
}

/**
 * 캠페인 표 그리기
 * 순서: (캠페인 API 실패면 오류만 표시) → ROAS 기준·검색어로 거르기 → 정렬 → 행 → 합계 행
 */
export function renderCampaigns() {
  state.current.shownCampaigns = [];
  state.current.shownTotal = null;
  campaignCsvBtn.disabled = true;

  // 캠페인 API만 실패: 이 화면에만 오류 + 다시 조회 (이전 목록은 남기지 않음)
  if (state.current.campaignError) {
    const err = state.current.campaignError;
    toolbarInfo.textContent = '캠페인 실적을 불러오지 못했습니다.';
    navCampaignCount.textContent = '';
    const retry = el('button', { type: 'button', class: 'btn btn-ghost btn-sm', text: '다시 조회' });
    retry.addEventListener('click', () => load(readForm()));
    campaignBody.replaceChildren(el('tr', { class: 'empty-row' }, el('td', { colspan: '9' },
      el('div', { class: 'inline-error', role: 'alert', text: err.status ? `${err.message} (HTTP ${err.status})` : '서버에 연결할 수 없습니다.' }),
      retry)));
    campaignFoot.replaceChildren();
    return;
  }

  const { key, dir } = state.sortState;
  const keywordRaw = searchInput.value.trim();
  const keyword = keywordRaw.toLowerCase();
  const all = state.current.campaigns;
  const filtered = Boolean(keyword) || state.roasBand !== 'all';
  const shown = all.filter((c) => inBand(c, state.roasBand)
    && (!keyword || c.campaignName.toLowerCase().includes(keyword) || c.campaignId.toLowerCase().includes(keyword)));

  // 정렬 상태 표시 (열 제목의 ↓↑ 화살표는 CSS가 aria-sort를 보고 그림)
  for (const th of campaignTable.querySelectorAll('th[data-key]')) {
    th.setAttribute('aria-sort', th.dataset.key === key ? (dir === 'asc' ? 'ascending' : 'descending') : 'none');
  }
  campaignCaption.textContent = `캠페인 실적, ${SORT_LABELS[key]} ${dir === 'asc' ? '오름차순' : '내림차순'} 정렬`;
  toolbarInfo.textContent = filtered ? `${shown.length}개 / 전체 ${all.length}개` : `전체 ${all.length}개`;
  navCampaignCount.textContent = String(all.length);

  if (shown.length === 0) {
    const td = el('td', { colspan: '9' }, el('div', { text: keyword ? `"${keywordRaw}"에 해당하는 캠페인이 없습니다.` : state.roasBand !== 'all' ? '선택한 ROAS 기준에 해당하는 캠페인이 없습니다.' : '조회 조건에 해당하는 캠페인이 없습니다.' }));
    if (keyword) {
      const clear = el('button', { type: 'button', class: 'btn btn-ghost btn-sm', text: '검색어 지우기' });
      clear.addEventListener('click', () => { searchInput.value = ''; renderCampaigns(); searchInput.focus(); });
      td.append(clear);
    }
    campaignBody.replaceChildren(el('tr', { class: 'empty-row' }, td));
    campaignFoot.replaceChildren();
    return;
  }

  // sort()는 안정 정렬 → 값이 같으면 API 순서(광고비 → 매체 → ID) 유지
  const sorted = [...shown].sort(compareBy(key, dir));
  state.current.shownCampaigns = sorted; // CSV는 화면에 보이는 순서 그대로
  campaignCsvBtn.disabled = false;
  campaignBody.replaceChildren(...sorted.map((c) => el('tr', {},
    el('td', {}, platformBadge(c.platform)),
    el('th', { scope: 'row', class: 'campaign-name' },
      el('span', { class: 'campaign-title', text: c.campaignName }),
      el('span', { class: 'campaign-id' }, el('span', { class: 'sr-only', text: ', 캠페인 ID ' }), c.campaignId)),
    ...metricCells(c, CAMPAIGN_COLUMNS))));

  // 합계 행: 검색·필터가 없으면 API totals 그대로, 있으면 보이는 캠페인만 합산해 지표 재계산
  const t = filtered ? sumMetrics(shown) : state.current.totals;
  const totalLabel = filtered ? `필터 결과 합계 (${shown.length}개)` : `전체 합계 (${all.length}개)`;
  state.current.shownTotal = { label: totalLabel, metrics: t }; // CSV 마지막 행에도 같은 합계
  campaignFoot.replaceChildren(el('tr', {},
    el('th', { scope: 'row', colspan: '2', text: totalLabel }),
    ...metricCells(t, CAMPAIGN_COLUMNS)));
}
