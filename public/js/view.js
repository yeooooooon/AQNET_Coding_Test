/**
 * 화면 상태 · 화면 전환
 * 로딩 · 오류 · 결과 표시 (오류 시 결과 영역을 숨겨 이전 값이 새 결과처럼 보이지 않게 함)
 * 사이드바 메뉴로 성과 요약 / 캠페인 실적 전환 (주소의 #overview, #campaigns)
 */
import { $, submitBtn, navCampaignCount, appliedEl, loadingEl, errorBanner, errorMessage, emptyEl, resultsEl, trendEl, briefCsvBtn, campaignCsvBtn } from './elements.js';
import { EMPTY_STATE, state } from './state.js';
import { describeFilters, hideTooltip } from './util.js';
import { applyDataRange, markPreset } from './query.js';
import { renderSummary, renderShare, renderBrief } from './overview.js';
import { renderTrend } from './trend.js';
import { renderCampaigns } from './campaigns.js';

// ---------- 로딩 · 오류 · 결과

/** 로딩 표시 켜기/끄기: 버튼 비활성 + "불러오는 중" 문구, 재조회 중이면 이전 결과를 흐리게 */
export function showLoading(on) {
  submitBtn.disabled = on;
  submitBtn.classList.toggle('is-loading', on);
  submitBtn.querySelector('.btn-label').textContent = on ? '조회 중' : '조회';
  loadingEl.hidden = !on;
  resultsEl.setAttribute('aria-busy', String(on));
  resultsEl.classList.toggle('is-stale', on && state.hasResult); // 재조회 중엔 이전 결과를 흐리게
  if (on) {
    errorBanner.hidden = true;
    emptyEl.hidden = true;
  }
}

/** 오류: 이전 결과를 숨겨서 "새 조회 결과"로 오해하지 않게 함 */
export function showError(error) {
  state.hasResult = false;
  state.current = { ...EMPTY_STATE };
  navCampaignCount.textContent = '';
  briefCsvBtn.disabled = true;
  campaignCsvBtn.disabled = true;
  resultsEl.hidden = true;
  appliedEl.hidden = true;
  emptyEl.hidden = true;
  if (error.status === 400) errorMessage.textContent = `조회 조건을 확인해 주세요. (${error.message})`;
  else if (error.status) errorMessage.textContent = `${error.message} (HTTP ${error.status})`;
  else errorMessage.textContent = '서버에 연결할 수 없습니다. 서버 실행 상태를 확인한 뒤 다시 조회해 주세요.';
  errorBanner.hidden = false;
}

/**
 * 조회 성공: 결과를 current에 저장하고 각 영역을 그림
 * @param campaignResult Promise.allSettled 결과 ({ status, value | reason }) — 캠페인 API는 실패할 수 있음
 * @param prevData 이전 기간 합계 (증감률용, 비교할 수 없으면 null)
 */
export function showResult(data, campaignResult, filters, prevData = null) {
  const campaignsOk = campaignResult.status === 'fulfilled';
  state.current = {
    ...EMPTY_STATE,
    filters,
    totals: data.totals,
    byPlatform: data.byPlatform,
    byDate: data.byDate ?? [],
    campaigns: campaignsOk ? campaignResult.value.items : [],
    campaignError: campaignsOk ? null : campaignResult.reason
  };
  applyDataRange(data.dataRange);
  markPreset(filters);
  briefCsvBtn.disabled = data.byPlatform.length === 0;
  renderSummary(data.totals, prevData);
  renderShare(data.byPlatform, data.totals);
  renderBrief(data.byPlatform, data.totals);
  resultsEl.hidden = false; // 그래프가 실제 너비를 잴 수 있도록 먼저 보이게
  if (!trendEl.closest('[hidden]')) renderTrend();
  renderCampaigns();
  emptyEl.hidden = data.byPlatform.length > 0; // 빈 결과 안내
  errorBanner.hidden = true;
  state.hasResult = true;
  appliedEl.textContent = `적용 조건: ${describeFilters(filters)}`;
  appliedEl.hidden = false;
}

// ---------- 화면 전환

export const VIEWS = {
  overview: { title: '성과 요약', sub: 'Google · Meta · Naver 광고 성과를 공통 지표로 통합해 보여 줍니다.' },
  campaigns: { title: '캠페인 실적', sub: '열 제목을 누르면 그 기준으로 정렬되고, 캠페인명·ID로 검색할 수 있습니다.' }
};

export const navLinks = [...document.querySelectorAll('.side-nav a[data-view]')];
export const viewPanels = [...document.querySelectorAll('[data-view-panel]')];

/** 화면 전환: 해당 화면만 보이게 + 메뉴 선택 표시 + 제목 변경. 성과 요약으로 오면 그래프를 새 너비로 다시 그림 */
export function showView(name) {
  const view = VIEWS[name] ? name : 'overview';
  for (const panel of viewPanels) panel.hidden = panel.dataset.viewPanel !== view;
  for (const link of navLinks) {
    if (link.dataset.view === view) link.setAttribute('aria-current', 'page');
    else link.removeAttribute('aria-current');
  }
  $('#view-title').textContent = VIEWS[view].title;
  $('#view-sub').textContent = VIEWS[view].sub;
  document.title = `${VIEWS[view].title} | 광고 성과 통합 대시보드`;
  hideTooltip();
  if (view === 'overview' && state.hasResult) renderTrend();
}
