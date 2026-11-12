/**
 * 광고 성과 대시보드 화면의 시작점 (일반 JavaScript, 외부 라이브러리 없음)
 *
 * 큰 흐름
 *   사용자가 조건을 바꿈(조회 버튼 · 기간 · 매체 · 빠른 기간)
 *     → load() [query.js]: GET /api/summary(필수) + /api/campaigns(선택 심화) + 이전 기간 summary(증감률) 동시 호출
 *     → 성공: showResult() [view.js]가 결과를 state.current에 저장하고 각 영역을 그림
 *       실패: showError() [view.js]가 결과 영역을 숨기고 오류 문구 + 다시 조회
 *   실패는 API별로 따로 처리: summary 실패만 화면 전체 오류, campaigns 실패는 캠페인 화면에만 오류
 *
 * 모듈 구성 (public/js/)
 *   main.js       시작 · 이벤트 연결 (화면의 모든 클릭·입력이 여기서 연결됨)
 *   elements.js   화면 요소 · 공통 상수        state.js     공유 상태
 *   util.js       공통 도우미                  query.js     조회 조건 · API 호출 · 빠른 기간
 *   view.js       로딩·오류·결과 · 화면 전환   overview.js  성과 요약 (카드 · 도넛 · 매체별 표)
 *   trend.js      일별 추이 그래프             campaigns.js 캠페인 실적
 *   csv.js        CSV 내보내기
 *
 * 보안: 화면에 넣는 값은 모두 textContent로만 넣음(innerHTML 미사용 → 데이터에 <script>가 있어도 글자로만 표시)
 */
import { $, form, presetButtons, trendEl, trendButtons, briefCsvBtn, campaignTable, searchInput, campaignScroll, campaignCsvBtn, bandButtons } from './elements.js';
import { state } from './state.js';
import { platformName, hideTooltip } from './util.js';
import { readForm, writeForm, filtersFromURL, validate, load, presetRange } from './query.js';
import { showView } from './view.js';
import { renderTrend } from './trend.js';
import { renderCampaigns } from './campaigns.js';
import { downloadCsv, csvName, METRIC_HEADERS, metricValues } from './csv.js';

// ---------- 조회 조건

// 조회 버튼
form.addEventListener('submit', (e) => {
  e.preventDefault();
  load(readForm());
});

// 매체·날짜를 바꾸면 조회 버튼 없이 바로 조회 (진행 중인 이전 요청은 load()에서 취소)
form.addEventListener('change', (e) => {
  if (e.target.name === 'platform' || e.target.type === 'date') load(readForm());
});

for (const btn of presetButtons) {
  btn.addEventListener('click', () => {
    const { start, end } = presetRange(Number(btn.dataset.days));
    writeForm({ ...readForm(), start, end });
    load(readForm());
  });
}

// 초기화: 기간·매체 조건 + 캠페인 검색어·정렬을 모두 처음 상태로 되돌리고 전체 조회
// (브라우저 기본 reset은 폼 칸만 비우므로 직접 처리)
form.addEventListener('reset', (e) => {
  e.preventDefault();
  writeForm({});
  validate({});
  searchInput.value = '';
  state.sortState = { key: 'cost', dir: 'desc' };
  state.roasBand = 'all';
  for (const b of bandButtons) b.setAttribute('aria-pressed', String(b.dataset.band === 'all'));
  load({});
});

// ---------- 화면 이동 · 오류

// 사이드바 메뉴(#overview / #campaigns) → 화면 전환
window.addEventListener('hashchange', () => showView(location.hash.slice(1)));

// 뒤로/앞으로: 주소의 조건으로 되돌려 다시 조회
window.addEventListener('popstate', () => {
  showView(location.hash.slice(1)); // 매체 행 클릭으로 이동한 뒤 뒤로가기 → 화면도 되돌림
  const filters = filtersFromURL();
  writeForm(filters);
  load(filters, { pushHistory: false });
});

// 오류 안내의 "다시 조회"
$('#retry-btn').addEventListener('click', () => load(readForm()));

// ---------- 성과 요약

// 일별 추이 묶음 버튼 (ROAS & 광고비 / CPA & 전환수)
for (const btn of trendButtons) {
  btn.addEventListener('click', () => {
    state.trendMode = btn.dataset.mode;
    for (const b of trendButtons) b.setAttribute('aria-pressed', String(b === btn));
    if (state.hasResult) renderTrend();
  });
}

// 창 크기가 바뀌면 그래프를 새 너비로 다시 그림 (숨겨진 화면에서는 너비를 잴 수 없으므로 건너뜀)
new ResizeObserver(() => { if (state.hasResult && !trendEl.closest('[hidden]')) renderTrend(); }).observe(trendEl);

// 매체별 표 CSV (매체별 행 + 합계 행)
briefCsvBtn.addEventListener('click', () => {
  downloadCsv(csvName('platform-summary'), ['매체', ...METRIC_HEADERS], [
    ...state.current.byPlatform.map((p) => [platformName(p.platform), ...metricValues(p)]),
    ['합계', ...metricValues(state.current.totals)]
  ]);
});

// Esc로 툴팁 닫기 (키보드 사용자도 닫을 수 있게)
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') hideTooltip();
});

// ---------- 캠페인 실적

// 캠페인 검색 (입력할 때마다 표만 다시 그림, 서버 재호출 없음)
searchInput.addEventListener('input', () => {
  campaignScroll.scrollTop = 0; // 검색어가 바뀌면 목록 맨 위부터
  if (state.hasResult) renderCampaigns();
});

// ROAS 기준 필터 (전체 · 우수 · 양호 · 주의)
for (const btn of bandButtons) {
  btn.addEventListener('click', () => {
    state.roasBand = btn.dataset.band;
    for (const b of bandButtons) b.setAttribute('aria-pressed', String(b === btn));
    campaignScroll.scrollTop = 0;
    if (state.hasResult) renderCampaigns();
  });
}

// 열 제목 클릭 정렬: 다른 열 → 그 열의 기본 방향(숫자는 큰 값부터, 이름은 가나다순) / 같은 열 → 방향 반전
campaignTable.querySelector('thead').addEventListener('click', (e) => {
  const th = e.target.closest('th[data-key]');
  if (!th || !e.target.closest('.th-btn')) return;
  const key = th.dataset.key;
  if (state.sortState.key === key) state.sortState = { key, dir: state.sortState.dir === 'asc' ? 'desc' : 'asc' };
  else state.sortState = { key, dir: key === 'campaignName' || key === 'cpa' ? 'asc' : 'desc' }; // CPA는 낮을수록 좋으므로 오름차순부터
  campaignScroll.scrollTop = 0; // 정렬이 바뀌면 목록 맨 위부터
  if (state.hasResult) renderCampaigns();
});

// 캠페인 CSV (지금 보이는 목록 + 합계 행)
campaignCsvBtn.addEventListener('click', () => {
  downloadCsv(csvName('campaigns'), ['매체', '캠페인 ID', '캠페인명', ...METRIC_HEADERS],
    [
      ...state.current.shownCampaigns.map((c) => [platformName(c.platform), c.campaignId, c.campaignName, ...metricValues(c)]),
      [state.current.shownTotal.label, '', '', ...metricValues(state.current.shownTotal.metrics)] // 화면과 같은 합계 행
    ]);
});

// ---------- 시작: 주소의 화면·조건으로 첫 조회

showView(location.hash.slice(1));
const initial = filtersFromURL();
writeForm(initial);
load(initial, { pushHistory: false });
