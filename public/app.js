/**
 * 광고 성과 대시보드 화면 (일반 JavaScript, 외부 라이브러리 없음)
 *
 * 큰 흐름
 *   사용자가 조건을 바꿈(조회 버튼 · 기간 · 매체 · 빠른 기간)
 *     → load(): GET /api/summary(필수) + /api/campaigns(선택 심화) + 이전 기간 summary(증감률)를 동시에 호출
 *     → 성공: showResult()가 결과를 current에 저장하고 각 영역을 그림
 *       실패: showError()가 결과 영역을 숨기고 오류 문구 + 다시 조회
 *   실패는 API별로 따로 처리: summary 실패만 화면 전체 오류, campaigns 실패는 캠페인 화면에만 오류
 *
 * 화면 상태 (문제지 7장)
 *   로딩    : 버튼 비활성 + "불러오는 중", 재조회 중이면 이전 결과를 흐리게
 *   오류    : 결과 영역을 숨김 → 이전 값이 새 결과처럼 보이지 않음
 *   빈 결과 : 안내 문구 + 합계 0, 지표는 "—"(계산 불가)
 *
 * 목차
 *    1. 화면 요소 · 공통 상수          9. 성과 요약 ③ 일별 성과 추이
 *    2. 상태                          10. 성과 요약 ④ 매체별 지표 표
 *    3. 공통 도우미                   11. 캠페인 실적
 *    4. 조회 조건 ↔ 입력칸 · 주소      12. 빠른 기간 선택
 *    5. API 조회                      13. CSV 내보내기
 *    6. 화면 상태: 로딩 · 오류 · 결과  14. 화면 전환
 *    7. 성과 요약 ① 요약 카드 · 증감   15. 이벤트 연결
 *    8. 성과 요약 ② 광고비 점유율      16. 시작
 *
 * 보안: 화면에 넣는 값은 모두 textContent로만 넣음(innerHTML 미사용 → 데이터에 <script>가 있어도 글자로만 표시)
 */

// =============================================================================
// 1. 화면 요소 · 공통 상수
// =============================================================================

const $ = (selector) => document.querySelector(selector);

// 사이드바 · 상태 안내
const form = $('#filter-form');
const startInput = $('#start');
const endInput = $('#end');
const submitBtn = $('#submit-btn');
const formError = $('#form-error');
const appliedEl = $('#applied');
const loadingEl = $('#loading');
const errorBanner = $('#error-banner');
const errorMessage = $('#error-message');
const emptyEl = $('#empty');
const resultsEl = $('#results');

// 성과 요약
const summaryEl = $('#summary');
const summarySubEl = $('#summary-sub');
const donut = $('#donut');
const donutTotal = $('#donut-total');
const donutDesc = $('#donut-desc');
const legendEl = $('#share-legend');
const tooltip = $('#tooltip');
const trendEl = $('#trend-chart');
const trendDesc = $('#trend-desc');
const trendLegend = $('#trend-legend');
const trendButtons = [...document.querySelectorAll('.trend-btn')];
const briefBody = $('#brief-body');
const briefFoot = $('#brief-foot');
const briefCsvBtn = $('#brief-csv');

// 캠페인 실적
const campaignTable = $('#campaign-table');
const campaignBody = $('#campaign-body');
const campaignFoot = $('#campaign-foot');
const campaignCaption = $('#campaign-caption');
const toolbarInfo = $('#toolbar-info');
const searchInput = $('#campaign-search');
const campaignScroll = document.querySelector('.campaign-scroll');
const campaignCsvBtn = $('#campaign-csv');
const bandButtons = [...document.querySelectorAll('.band-btn')];
const navCampaignCount = $('#nav-campaign-count');
const presetButtons = [...document.querySelectorAll('.preset')];

const PLATFORM_LABELS = { google: 'Google', meta: 'Meta', naver: 'Naver' };
const FILTER_KEYS = ['start', 'end', 'platform']; // API 쿼리로 보내는 조회 조건

// =============================================================================
// 2. 상태
//    화면에 보이는 값은 모두 "마지막으로 성공한 조회 결과(current)"에서 그림
// =============================================================================

let controller = null; // 진행 중인 요청 (새 조회 시 취소)
let hasResult = false; // 현재 화면에 유효한 결과가 표시되어 있는지

/**
 * current = 마지막으로 성공한 조회 결과
 *   filters        : 그 결과를 만든 조회 조건 (적용 조건 표시·CSV 파일명)
 *   totals · byPlatform · byDate : /api/summary 응답
 *   campaigns      : /api/campaigns 응답 (검색·정렬·필터는 이 목록 안에서만)
 *   campaignError  : 캠페인 API만 실패했을 때의 오류 (성과 요약은 정상 표시)
 *   shownCampaigns · shownTotal : 지금 캠페인 표에 보이는 목록·합계 (CSV가 그대로 사용)
 */
const EMPTY_STATE = { filters: null, totals: null, byPlatform: [], byDate: [], campaigns: [], campaignError: null, shownCampaigns: [], shownTotal: null };
let current = { ...EMPTY_STATE };
let dataRange = { start: null, end: null }; // 전체 데이터 기간 (API dataRange) → 빠른 기간 선택 기준
let sortState = { key: 'cost', dir: 'desc' }; // 캠페인 표 정렬 (기본: 광고비 내림차순 = API 순서)
let trendMode = 'roas-cost'; // 일별 추이 그래프 묶음 (9번)
let roasBand = 'all';         // 캠페인 ROAS 기준 필터 (11번)

// =============================================================================
// 3. 공통 도우미 (요소 만들기 · 숫자 표시 · 날짜 · 툴팁 위치)
// =============================================================================

const nf = new Intl.NumberFormat('ko-KR', { maximumFractionDigits: 2 }); // 1,234.56 (0은 "0")

/**
 * 화면 요소 만들기: el('td', { class: 'num', text: '1,000' }, 자식…)
 * text는 textContent로 넣으므로 HTML로 해석되지 않음 (XSS 방지)
 */
function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (key === 'text') node.textContent = value;
    else if (key === 'class') node.className = value;
    else node.setAttribute(key, value);
  }
  node.append(...children.filter((child) => child != null)); // null(예: 비교 불가한 증감 배지)은 건너뜀
  return node;
}

/** SVG 요소 만들기 (도넛·일별 추이 그래프) */
function svg(tag, attrs = {}) {
  const node = document.createElementNS('http://www.w3.org/2000/svg', tag);
  for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, value);
  return node;
}

/** SVG 글자 요소 (그래프 축 글자) */
function svgText(text, attrs) {
  const node = svg('text', attrs);
  node.textContent = text;
  return node;
}

/** null(분모 0) → "—" + 스크린리더용 "계산 불가". 0은 그대로 "0" */
function valueNodes(value, reason = '계산 불가') {
  if (value === null || value === undefined) {
    return [el('span', { class: 'na', 'aria-hidden': 'true', title: reason, text: '—' }), el('span', { class: 'sr-only', text: reason })];
  }
  return [nf.format(value)];
}

/** "120원", "3.5%" 처럼 단위를 붙인 글자. null이면 "—" */
const withUnit = (value, unit) => (value === null ? '—' : `${nf.format(value)}${unit}`);
const platformName = (p) => PLATFORM_LABELS[p] ?? p;

/** 매체 표시: 색 점 + 매체명 (색만으로 구분하지 않도록 이름을 항상 함께) */
function platformBadge(platform) {
  return el('span', { class: 'badge', 'data-platform': platform },
    el('span', { class: 'dot', 'aria-hidden': 'true' }), platformName(platform));
}

/** 적용 조건 문장: "2026.11.01 ~ 2026.11.03 · Meta" */
function describeFilters(f) {
  const dot = (d) => d.replaceAll('-', '.');
  const period = f.start || f.end ? `${f.start ? dot(f.start) : '처음'} ~ ${f.end ? dot(f.end) : '끝'}` : '전체 기간';
  return `${period} · ${f.platform ? platformName(f.platform) : '전체 매체'}`;
}

/** 'YYYY-MM-DD'에서 n일 이동 (UTC 기준 → 시간대 영향 없음) */
function addDays(date, n) {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/** 툴팁을 마우스 옆에 두되 화면 밖으로 나가지 않게 */
function positionTooltip(x, y) {
  const pad = 14;
  const { width, height } = tooltip.getBoundingClientRect();
  tooltip.style.left = `${Math.max(8, Math.min(x + pad, window.innerWidth - width - 8))}px`;
  tooltip.style.top = `${Math.max(8, y + pad + height > window.innerHeight ? y - height - pad : y + pad)}px`;
}

function hideTooltip() {
  tooltip.hidden = true;
}

// =============================================================================
// 4. 조회 조건 ↔ 입력칸 · 주소
//    조건을 주소(?start=…&platform=…)에 남겨 새로고침·뒤로 가기·링크 공유 시에도 유지
// =============================================================================

function readForm() {
  return { start: startInput.value, end: endInput.value, platform: form.elements.platform.value };
}

function writeForm(f) {
  startInput.value = f.start || '';
  endInput.value = f.end || '';
  // 라디오 묶음에 value를 한 번에 넣으면 "전체"(value="") 선택 표시가 바뀌지 않는 경우가 있어 버튼마다 직접 지정
  const platform = PLATFORM_LABELS[f.platform] ? f.platform : '';
  for (const radio of form.querySelectorAll('input[name="platform"]')) radio.checked = radio.value === platform;
}

function filtersFromURL() {
  const params = new URLSearchParams(location.search);
  return Object.fromEntries(FILTER_KEYS.map((key) => [key, params.get(key) || '']));
}

/** 빈 값은 빼고 쿼리 문자열로 → "start=2026-11-01&platform=meta" */
function toQuery(f) {
  const params = new URLSearchParams();
  for (const key of FILTER_KEYS) if (f[key]) params.set(key, f[key]);
  return params.toString();
}

/** 브라우저 단에서 막을 수 있는 오류만 미리 안내 (서버도 같은 검사를 하고 400을 돌려줌) */
function validate(f) {
  const invalid = Boolean(f.start && f.end && f.start > f.end);
  startInput.setAttribute('aria-invalid', String(invalid));
  endInput.setAttribute('aria-invalid', String(invalid));
  formError.hidden = !invalid;
  formError.textContent = invalid ? '시작일은 종료일보다 늦을 수 없습니다.' : '';
  return !invalid;
}

// =============================================================================
// 5. API 조회
//    load(): 조건 검증 → 주소 반영 → 이전 요청 취소 → API 3개 동시 호출 → 결과/오류 화면
// =============================================================================

/** GET + JSON 변환. 실패(400/500 등)면 서버가 보낸 message로 에러를 던짐 */
async function fetchJson(path, query, signal) {
  const res = await fetch(`${path}${query ? `?${query}` : ''}`, { signal, headers: { accept: 'application/json' } });
  let body = null;
  try { body = await res.json(); } catch { /* JSON이 아닌 응답 */ }
  if (!res.ok || !body) {
    const error = new Error(body?.message || `서버 응답 오류 (HTTP ${res.status})`);
    error.status = res.status;
    throw error;
  }
  return body;
}

/**
 * 이전 기간 비교: 시작일·종료일이 모두 있을 때만, 같은 일수의 바로 앞 기간
 * 예) 11.03~11.09(7일) → 10.27~11.02. 매체 조건은 그대로
 */
function previousPeriod(f) {
  if (!f.start || !f.end) return null;
  const days = Math.round((Date.parse(f.end) - Date.parse(f.start)) / 86_400_000) + 1;
  const end = addDays(f.start, -1);
  const start = addDays(end, -(days - 1));
  if (start < '2000-01-01') return null; // API 날짜 범위 밖
  return { ...f, start, end };
}

/**
 * 조회의 중심 함수
 * @param pushHistory true면 주소를 새 기록으로 남김 (뒤로 가기로 돌아왔을 때는 false)
 */
async function load(filters, { pushHistory = true } = {}) {
  if (!validate(filters)) return;
  const query = toQuery(filters);
  const search = query ? `?${query}` : '';
  if (pushHistory && search !== location.search) history.pushState(null, '', `${search || location.pathname}${location.hash}`);

  // 이전 요청 취소 → 늦게 도착한 옛 응답이 최신 결과를 덮어쓰지 않도록
  controller?.abort();
  const ctrl = new AbortController();
  controller = ctrl;
  showLoading(true);

  try {
    // 두 API를 같은 조건으로 동시에 호출하되 실패는 따로 처리
    // - summary(필수) 실패 → 화면 전체 오류
    // - campaigns(선택 심화) 실패 → 캠페인 화면에만 오류 (선택 기능 때문에 필수 화면이 막히지 않도록)
    // - 이전 기간 비교(부가 기능) 실패 → 증감률만 숨김
    const prev = previousPeriod(filters);
    const [summary, campaigns, prevSummary] = await Promise.allSettled([
      fetchJson('/api/summary', query, ctrl.signal),
      fetchJson('/api/campaigns', query, ctrl.signal),
      prev ? fetchJson('/api/summary', toQuery(prev), ctrl.signal) : Promise.resolve(null)
    ]);
    if (summary.status === 'rejected') throw summary.reason; // 취소(AbortError)도 여기서 아래 catch로
    if (ctrl.signal.aborted) return;
    const prevData = prevSummary.status === 'fulfilled' && prevSummary.value?.quality.matchedRows > 0
      ? { totals: prevSummary.value.totals, filters: prev } : null; // 이전 기간에 데이터가 없으면 비교하지 않음
    showResult(summary.value, campaigns, filters, prevData);
  } catch (error) {
    if (error.name === 'AbortError') return;
    showError(error);
  } finally {
    if (controller === ctrl) {
      controller = null;
      showLoading(false);
    }
  }
}

// =============================================================================
// 6. 화면 상태: 로딩 · 오류 · 결과
//    오류가 나면 결과 영역을 통째로 숨겨 이전 값이 새 결과처럼 보이지 않게 함
// =============================================================================

/** 로딩 표시 켜기/끄기: 버튼 비활성 + "불러오는 중" 문구, 재조회 중이면 이전 결과를 흐리게 */
function showLoading(on) {
  submitBtn.disabled = on;
  submitBtn.classList.toggle('is-loading', on);
  submitBtn.querySelector('.btn-label').textContent = on ? '조회 중' : '조회';
  loadingEl.hidden = !on;
  resultsEl.setAttribute('aria-busy', String(on));
  resultsEl.classList.toggle('is-stale', on && hasResult); // 재조회 중엔 이전 결과를 흐리게
  if (on) {
    errorBanner.hidden = true;
    emptyEl.hidden = true;
  }
}

/** 오류: 이전 결과를 숨겨서 "새 조회 결과"로 오해하지 않게 함 */
function showError(error) {
  hasResult = false;
  current = { ...EMPTY_STATE };
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
function showResult(data, campaignResult, filters, prevData = null) {
  const campaignsOk = campaignResult.status === 'fulfilled';
  current = {
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
  hasResult = true;
  appliedEl.textContent = `적용 조건: ${describeFilters(filters)}`;
  appliedEl.hidden = false;
}

// =============================================================================
// 7. 성과 요약 ① 요약 카드 · 보조 지표 · 이전 기간 대비 증감
// =============================================================================

/**
 * 요약: 카드 5개(광고비·전환매출·전환수·CPA·ROAS) + 보조 지표 줄(노출·클릭·CTR·CPC)
 * → 문제지 요약 7개 지표(광고비·전환수·전환매출·CTR·CPC·CPA·ROAS)를 모두 이름과 함께 표시
 * 각 행: [응답 키, 라벨, 단위, 설명, 계산 불가일 때 이유]
 */
function renderSummary(t, prev) {
  const cards = [
    ['cost', '총 광고비', '원', '광고비 합계'],
    ['revenue', '총 전환매출', '원', '전환매출 합계'],
    ['conversions', '총 전환수', '건', '전환 합계'],
    ['cpa', 'CPA', '원', '전환 1건당 광고비', '전환이 0건이라 계산 불가'],
    ['roas', 'ROAS', '%', '광고비 대비 전환매출', '광고비가 0원이라 계산 불가']
  ];
  summaryEl.replaceChildren(...cards.map(([key, label, unit, note, reason]) => {
    const value = el('p', { class: 'kpi-value' }, ...valueNodes(t[key], reason));
    if (t[key] !== null) value.append(el('span', { class: 'kpi-unit', text: unit }));
    return el('article', { class: key === 'roas' ? 'kpi kpi-key' : 'kpi' },
      el('div', { class: 'kpi-head' }, el('p', { class: 'kpi-label', text: label }), deltaBadge(key, t, prev)), value,
      el('p', { class: 'kpi-note', text: t[key] === null ? reason : note }));
  }));

  const stats = [
    ['impressions', '노출', '회'],
    ['clicks', '클릭', '회'],
    ['ctr', 'CTR (클릭률)', '%', '노출이 0이라 계산 불가'],
    ['cpc', 'CPC (클릭당 비용)', '원', '클릭이 0이라 계산 불가']
  ];
  summarySubEl.replaceChildren(...stats.map(([key, label, unit, reason]) => {
    const dd = el('dd', {}, ...valueNodes(t[key], reason));
    if (t[key] !== null) dd.append(el('span', { class: 'kpi-unit', text: unit }));
    return el('div', { class: 'strip-item' }, el('dt', {}, label, deltaBadge(key, t, prev)), dd);
  }));
}

/**
 * 지표별 증감 방향의 의미: up = 오를수록 좋음, down = 내릴수록 좋음(비용 지표), none = 좋고 나쁨 없음(광고비)
 * 비율 지표(CTR·ROAS)는 %p(차이), 나머지는 %(변화율)
 */
const DELTA_RULES = {
  cost: { good: 'none', kind: 'pct' },
  revenue: { good: 'up', kind: 'pct' },
  conversions: { good: 'up', kind: 'pct' },
  impressions: { good: 'up', kind: 'pct' },
  clicks: { good: 'up', kind: 'pct' },
  cpa: { good: 'down', kind: 'pct' },
  cpc: { good: 'down', kind: 'pct' },
  ctr: { good: 'up', kind: 'pp' },
  roas: { good: 'up', kind: 'pp' }
};

/** 이전 기간 대비 증감 배지. 비교할 수 없으면(이전 기간 없음·값 null·이전 값 0) 표시하지 않음 */
function deltaBadge(key, t, prev) {
  if (!prev) return null;
  const now = t[key];
  const before = prev.totals[key];
  const rule = DELTA_RULES[key];
  if (now === null || before === null || (rule.kind === 'pct' && before === 0)) return null;
  const diff = rule.kind === 'pp' ? now - before : ((now - before) / before) * 100;
  const shown = Math.round(Math.abs(diff) * 10) / 10; // 표시용 소수 첫째 자리
  const dir = shown === 0 ? 'flat' : diff > 0 ? 'up' : 'down';
  const tone = dir === 'flat' || rule.good === 'none' ? 'neutral' : dir === rule.good ? 'good' : 'bad';
  const unit = rule.kind === 'pp' ? '%p' : '%';
  const arrow = dir === 'up' ? '▲' : dir === 'down' ? '▼' : '';
  const period = `이전 기간(${prev.filters.start.slice(5).replace('-', '.')}~${prev.filters.end.slice(5).replace('-', '.')}) 대비`;
  const words = dir === 'flat' ? '변화 없음' : `${nf.format(shown)}${unit} ${dir === 'up' ? '증가' : '감소'}`;
  return el('span', { class: `delta delta-${tone}`, title: `${period} ${words}` },
    el('span', { 'aria-hidden': 'true', text: `${arrow} ${nf.format(shown)}${unit}`.trim() }),
    el('span', { class: 'sr-only', text: `, ${period} ${words}` }));
}

// =============================================================================
// 8. 성과 요약 ② 광고비 점유율 도넛
// =============================================================================

/**
 * 광고비 점유율 도넛 + 범례
 * 원 둘레를 100으로 보고(pathLength=100), 매체별 점유율만큼 선을 이어 그립니다.
 * 범례에 매체명·점유율·금액을 글자로 함께 적어 색만으로 구분하지 않게 함.
 */
function renderShare(byPlatform, totals) {
  hideTooltip();
  donut.replaceChildren(svg('circle', { class: 'track', cx: 60, cy: 60, r: 48 }));
  donutTotal.textContent = withUnit(totals.cost, '원');

  const withCost = byPlatform.filter((p) => p.cost > 0);
  if (!totals.cost || withCost.length === 0) {
    legendEl.replaceChildren(el('li', { class: 'empty-inline', text: byPlatform.length ? '광고비가 집행된 매체가 없습니다.' : '조회 조건에 해당하는 데이터가 없습니다.' }));
    donutDesc.textContent = '매체별 광고비 데이터 없음';
    return;
  }

  const share = (p) => (p.cost / totals.cost) * 100;
  const gap = withCost.length > 1 ? 0.8 : 0; // 조각 사이 틈
  let offset = 0;
  for (const p of withCost) {
    const seg = svg('circle', {
      class: 'seg', cx: 60, cy: 60, r: 48, pathLength: 100, 'data-platform': p.platform,
      'stroke-dasharray': `${Math.max(share(p) - gap, 0.01)} ${100 - share(p) + gap}`, // 그릴 길이, 비울 길이
      'stroke-dashoffset': -offset                                                    // 이전 조각이 끝난 위치부터
    });
    seg.addEventListener('mouseenter', (e) => showTooltip(p, share(p), e.clientX, e.clientY));
    seg.addEventListener('mousemove', (e) => positionTooltip(e.clientX, e.clientY));
    seg.addEventListener('mouseleave', hideTooltip);
    donut.append(seg);
    offset += share(p);
  }

  legendEl.replaceChildren(...byPlatform.map((p) => el('li', {},
    el('span', { class: 'name' }, platformBadge(p.platform)),
    el('span', { class: 'pct', text: `${nf.format(Math.round(share(p) * 10) / 10)}%` }),
    el('span', { class: 'amt', text: withUnit(p.cost, '원') }))));
  donutDesc.textContent = `매체별 광고비 점유율: ${byPlatform.map((p) => `${platformName(p.platform)} ${nf.format(Math.round(share(p) * 10) / 10)}%`).join(', ')}`;
}

// 도넛 툴팁: 조각에 마우스를 올리면 매체별 상세 지표. 마우스를 떼거나 Esc로 닫힘
function showTooltip(p, share, x, y) {
  const rows = [['점유율', `${nf.format(Math.round(share * 10) / 10)}%`], ['광고비', withUnit(p.cost, '원')],
    ['전환', withUnit(p.conversions, '건')], ['매출', withUnit(p.revenue, '원')], ['CPA', withUnit(p.cpa, '원')], ['ROAS', withUnit(p.roas, '%')]];
  tooltip.replaceChildren(el('strong', {}, platformBadge(p.platform)),
    el('dl', {}, ...rows.flatMap(([label, value]) => [el('dt', { text: label }), el('dd', { text: value })])));
  tooltip.hidden = false;
  positionTooltip(x, y);
}

// =============================================================================
// 9. 성과 요약 ③ 일별 성과 추이 (SVG 직접 그림, 외부 라이브러리 없음)
//    막대(왼쪽 축) + 선(오른쪽 축)을 겹친 그래프. 버튼으로 두 묶음 중 하나 선택
//      - ROAS & 광고비 : 광고비 막대(원) + ROAS 선(%)  ← 쓴 만큼 벌었나
//      - CPA & 전환수  : 전환수 막대(건) + CPA 선(원)  ← 전환의 양과 1건당 비용
//    단위가 다른 두 값을 구분하도록 오른쪽 축 글자는 선과 같은 색, 범례에 단위 표시
// =============================================================================

const TREND_MODES = {
  'roas-cost': {
    bar: { key: 'cost', label: '광고비', unit: '원' },
    line: { key: 'roas', label: 'ROAS', unit: '%' },
    tone: 'a'
  },
  'cpa-conversions': {
    bar: { key: 'conversions', label: '전환수', unit: '건' },
    line: { key: 'cpa', label: 'CPA', unit: '원' }, // 전환 0건인 날은 null → 선을 끊음
    tone: 'b'
  }
};

/** 축 눈금용 짧은 표기: 1억 2천만 → "1.2억", 350만 원 → "350만". 100만 원 미만·%·건은 그대로 */
function compactNumber(value, unit) {
  if (unit === '%') return `${nf.format(value)}%`;
  if (unit === '원' && value >= 1e8) return `${nf.format(Math.round(value / 1e7) / 10)}억`;
  if (unit === '원' && value >= 1e6) return `${nf.format(Math.round(value / 1e4))}만`;
  return nf.format(value);
}

/** 보기 좋은 눈금 간격 (1·2·2.5·5 × 10의 거듭제곱) */
function niceStep(raw) {
  if (raw <= 0) return 1;
  const exp = 10 ** Math.floor(Math.log10(raw));
  const f = raw / exp;
  return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 2.5 ? 2.5 : f <= 5 ? 5 : 10) * exp;
}

/**
 * 눈금 4칸(5개 눈금)으로 나뉘는 축 범위
 * - 막대 축: 0부터 시작 (막대 길이가 값에 비례해야 하므로)
 * - 선 축: 값의 최소~최대 근처만 (변화가 보이도록). 두 축의 눈금 위치를 맞추려고 둘 다 4칸
 */
function axisRange(values, fromZero) {
  const nums = values.filter((v) => v !== null);
  if (nums.length === 0) return { lo: 0, hi: 1 };
  const max = Math.max(...nums);
  const min = fromZero ? 0 : Math.min(...nums);
  let step = niceStep((max - min) / 4 || max / 4 || 1);
  let lo = fromZero ? 0 : Math.floor(min / step) * step;
  while (lo + step * 4 < max) { step = niceStep(step * 1.01); lo = fromZero ? 0 : Math.floor(min / step) * step; }
  return { lo, hi: lo + step * 4 };
}

/** 아래는 각지고 위쪽 모서리만 둥근 막대 경로 (기준선에서 자라는 모양) */
function barPath(x, y, w, h, r = 4) {
  if (h <= 0) return '';
  const rr = Math.min(r, w / 2, h);
  return `M${x},${y + h}V${y + rr}Q${x},${y} ${x + rr},${y}H${x + w - rr}Q${x + w},${y} ${x + w},${y + rr}V${y + h}Z`;
}

/**
 * 부드러운 곡선 경로 (monotone cubic: Fritsch–Carlson)
 * 점과 점 사이를 곡선으로 잇되, 실제 값보다 위아래로 튀어나가지 않음 → 없는 최고·최저점을 만들지 않음
 */
function smoothPath(points) {
  if (points.length < 2) return points.length ? `M${points[0][0]},${points[0][1]}` : '';
  const n = points.length;
  const dx = [];
  const slope = [];
  for (let i = 0; i < n - 1; i += 1) {
    dx[i] = points[i + 1][0] - points[i][0];
    slope[i] = (points[i + 1][1] - points[i][1]) / dx[i];
  }
  const t = [slope[0]];
  for (let i = 1; i < n - 1; i += 1) t[i] = slope[i - 1] * slope[i] <= 0 ? 0 : (slope[i - 1] + slope[i]) / 2;
  t[n - 1] = slope[n - 2];
  for (let i = 0; i < n - 1; i += 1) {
    if (slope[i] === 0) { t[i] = 0; t[i + 1] = 0; continue; }
    const a = t[i] / slope[i];
    const b = t[i + 1] / slope[i];
    const s = a * a + b * b;
    if (s > 9) { const k = 3 / Math.sqrt(s); t[i] = k * a * slope[i]; t[i + 1] = k * b * slope[i]; }
  }
  let d = `M${points[0][0]},${points[0][1]}`;
  for (let i = 0; i < n - 1; i += 1) {
    const [x0, y0] = points[i];
    const [x1, y1] = points[i + 1];
    const h = dx[i] / 3;
    d += `C${x0 + h},${y0 + t[i] * h} ${x1 - h},${y1 - t[i + 1] * h} ${x1},${y1}`;
  }
  return d;
}

/** 일별 추이 그리기: 축 범위 계산 → 눈금 → 날짜 → 막대 → 선 → 마우스 감지 영역 */
function renderTrend() {
  const days = current.byDate;
  const mode = TREND_MODES[trendMode];
  const width = trendEl.clientWidth || 640;
  const height = trendEl.clientHeight || 280;
  const pad = { top: 16, right: 56, bottom: 28, left: 56 };
  const plotW = width - pad.left - pad.right;
  const plotH = height - pad.top - pad.bottom;

  // 범례: ● 선 지표(단위)  ● 막대 지표(단위)
  trendLegend.replaceChildren(
    el('span', { class: `legend-item line-${mode.tone}` }, el('span', { class: 'swatch', 'aria-hidden': 'true' }), `${mode.line.label} (${mode.line.unit})`),
    el('span', { class: `legend-item bar-${mode.tone}` }, el('span', { class: 'swatch', 'aria-hidden': 'true' }), `${mode.bar.label} (${mode.bar.unit})`));

  const root = svg('svg', { viewBox: `0 0 ${width} ${height}`, 'aria-hidden': 'true' });
  if (days.length === 0) {
    root.append(svgText('표시할 데이터가 없습니다.', { class: 'empty', x: width / 2, y: height / 2, 'text-anchor': 'middle' }));
    trendEl.replaceChildren(root);
    trendDesc.textContent = '일별 추이 데이터 없음';
    return;
  }

  const barValues = days.map((d) => d[mode.bar.key]);
  const lineValues = days.map((d) => d[mode.line.key]); // ROAS는 광고비 0원인 날 null
  const barAxis = axisRange(barValues, true);
  const lineAxis = axisRange(lineValues, false);
  const yOf = (v, axis) => pad.top + plotH - ((v - axis.lo) / (axis.hi - axis.lo)) * plotH;

  // 가로 눈금선 + 왼쪽(막대)·오른쪽(선) 축 글자. 두 축 모두 4칸이라 같은 높이에 눈금
  for (let i = 0; i <= 4; i += 1) {
    const y = pad.top + plotH - (plotH / 4) * i;
    root.append(svg('line', { class: 'grid', x1: pad.left, x2: width - pad.right, y1: y, y2: y }));
    root.append(svgText(compactNumber(barAxis.lo + ((barAxis.hi - barAxis.lo) / 4) * i, mode.bar.unit), { class: 'axis-text', x: pad.left - 8, y: y + 4, 'text-anchor': 'end' }));
    root.append(svgText(compactNumber(lineAxis.lo + ((lineAxis.hi - lineAxis.lo) / 4) * i, mode.line.unit), { class: `axis-text axis-line line-${mode.tone}`, x: width - pad.right + 8, y: y + 4, 'text-anchor': 'start' }));
  }

  // 날짜: 글자가 겹치지 않게 칸이 좁으면 일부만 표시
  const step = plotW / days.length;
  const labelEvery = Math.max(1, Math.ceil(44 / step));
  const xCenter = (i) => pad.left + step * i + step / 2;
  days.forEach((d, i) => {
    if (i % labelEvery !== 0 && i !== days.length - 1) return;
    root.append(svgText(d.date.slice(5).replace('-', '.'), { class: 'axis-text', x: xCenter(i), y: height - 8, 'text-anchor': 'middle' }));
  });

  // 막대
  const barW = Math.min(24, step * 0.55);
  const bars = days.map((d, i) => {
    const y = yOf(barValues[i], barAxis);
    const bar = svg('path', { class: `bar bar-${mode.tone}`, d: barPath(xCenter(i) - barW / 2, y, barW, pad.top + plotH - y) });
    root.append(bar);
    return bar;
  });

  // 선: 계산 불가(null)인 날에서 끊고, 이어진 구간마다 부드러운 곡선
  let segment = [];
  const flush = () => { if (segment.length) root.append(svg('path', { class: `line line-${mode.tone}`, d: smoothPath(segment) })); segment = []; };
  const points = days.map((d, i) => {
    if (lineValues[i] === null) { flush(); return null; }
    const p = [xCenter(i), yOf(lineValues[i], lineAxis)];
    segment.push(p);
    return p;
  });
  flush();
  const dots = points.map((p) => {
    if (!p) return null;
    const dot = svg('circle', { class: `point line-${mode.tone}`, cx: p[0], cy: p[1], r: 4 });
    root.append(dot);
    return dot;
  });

  // 마우스 감지 영역: 날짜 칸 전체 → 그날의 두 지표 + 주요 값 툴팁
  days.forEach((d, i) => {
    const hit = svg('rect', { class: 'hit', x: pad.left + step * i, y: pad.top, width: step, height: plotH });
    const on = (e) => { bars[i].classList.add('is-hover'); dots[i]?.classList.add('is-hover'); showDayTooltip(d, mode, e.clientX, e.clientY); };
    hit.addEventListener('mouseenter', on);
    hit.addEventListener('mousemove', (e) => positionTooltip(e.clientX, e.clientY));
    hit.addEventListener('mouseleave', () => { bars[i].classList.remove('is-hover'); dots[i]?.classList.remove('is-hover'); hideTooltip(); });
    root.append(hit);
  });

  trendEl.replaceChildren(root);
  trendDesc.textContent = `${mode.bar.label}(막대)와 ${mode.line.label}(선)의 일별 추이, ${days[0].date}부터 ${days[days.length - 1].date}까지 ${days.length}일. 날짜별 값은 아래 표와 CSV에서도 확인할 수 있습니다.`;
}

/** 날짜 툴팁: 그래프의 두 값 + 그래프에 없는 주요 값 */
function showDayTooltip(d, mode, x, y) {
  const rows = [
    [mode.bar.label, withUnit(d[mode.bar.key], mode.bar.unit)],
    [mode.line.label, withUnit(d[mode.line.key], mode.line.unit)],
    // 그래프에 없는 주요 값도 함께 (이미 위에 나온 지표는 제외)
    ...[['cost', '광고비', '원'], ['revenue', '전환매출', '원'], ['conversions', '전환수', '건'], ['roas', 'ROAS', '%']]
      .filter(([key]) => key !== mode.bar.key && key !== mode.line.key)
      .map(([key, label, unit]) => [label, withUnit(d[key], unit)])
  ];
  tooltip.replaceChildren(el('strong', { text: d.date.replaceAll('-', '.') }),
    el('dl', {}, ...rows.flatMap(([label, value]) => [el('dt', { text: label }), el('dd', { text: value })])));
  tooltip.hidden = false;
  positionTooltip(x, y);
}

// =============================================================================
// 10. 성과 요약 ④ 매체별 지표 표 (행 클릭 → 그 매체의 캠페인 실적으로 이동)
// =============================================================================

/** 매체별 표의 숫자 열 9개 (index.html thead 순서와 같음). CSV도 같은 순서 */
const BRIEF_COLUMNS = ['cost', 'impressions', 'clicks', 'conversions', 'revenue', 'ctr', 'cpc', 'cpa', 'roas'];

/** 숫자 칸들: 단위는 열 제목에 있으므로 숫자만. null은 "—"(계산 불가). ROAS 열만 강조 */
function metricCells(row, columns) {
  return columns.map((key) => el('td', { class: key === 'roas' ? 'num roas' : 'num' }, ...valueNodes(row[key])));
}

/**
 * 매체별 표 + 합계 행 (성과 요약 화면)
 * 칸: 매체 · 광고비 · 노출 · 클릭 · 전환 · 매출 · CTR · CPC · CPA · ROAS (문제지 10개 항목)
 */
function renderBrief(byPlatform, totals) {
  if (byPlatform.length === 0) {
    briefBody.replaceChildren(el('tr', { class: 'empty-row' },
      el('td', { colspan: '10', text: '조회 조건에 해당하는 데이터가 없습니다.' })));
    briefFoot.replaceChildren();
    return;
  }
  briefBody.replaceChildren(...byPlatform.map((p) => {
    const cells = metricCells(p, BRIEF_COLUMNS);
    const row = el('tr', { class: 'row-link', tabindex: '0', title: `${platformName(p.platform)} 캠페인 실적 보기` },
      el('th', { scope: 'row' }, platformBadge(p.platform)), ...cells);
    const open = () => drillDown(p.platform);
    row.addEventListener('click', open);
    row.addEventListener('keydown', (ev) => { if (ev.key === 'Enter') open(); });
    return row;
  }));
  briefFoot.replaceChildren(el('tr', {}, el('th', { scope: 'row', text: '합계' }), ...metricCells(totals, BRIEF_COLUMNS)));
}

/**
 * 매체 행 클릭: 그 매체로 조건을 바꾸고 캠페인 실적 화면으로 이동해 다시 조회
 * location.hash를 직접 바꾸면 브라우저가 popstate(뒤로가기 처리)를 즉시 일으켜
 * 주소의 옛 조건으로 폼을 덮어쓰므로, 주소(조건 + #campaigns)를 pushState로 한 번에 바꿈
 */
function drillDown(platform) {
  const filters = { ...readForm(), platform };
  writeForm(filters);
  const query = toQuery(filters);
  history.pushState(null, '', `${query ? `?${query}` : location.pathname}#campaigns`);
  showView('campaigns');
  load(filters, { pushHistory: false });
}

// =============================================================================
// 11. 캠페인 실적 (검색 · ROAS 기준 필터 · 정렬)
//    집계는 서버(/api/campaigns)가 하고, 화면은 받은 목록 안에서 걸러 보기·순서 바꾸기만 함
// =============================================================================

/** 캠페인 표의 숫자 열 7개 (index.html thead 순서와 같음) */
const CAMPAIGN_COLUMNS = ['cost', 'impressions', 'clicks', 'conversions', 'revenue', 'cpa', 'roas'];

/**
 * ROAS 기준 필터 (운영 기준 가정 — 데이터에서 나온 값이 아님, 여기 상수만 바꾸면 됨)
 * 우수: 450% 이상 / 양호: 350% 이상 450% 미만 / 주의: 350% 미만
 * ROAS를 계산할 수 없는 캠페인(광고비 0원 → null)은 "전체"에서만 보임
 */
const ROAS_BANDS = { high: 450, low: 350 };

const inBand = (c, band) => {
  if (band === 'all') return true;
  if (c.roas === null) return false;
  if (band === 'high') return c.roas >= ROAS_BANDS.high;
  if (band === 'low') return c.roas < ROAS_BANDS.low;
  return c.roas >= ROAS_BANDS.low && c.roas < ROAS_BANDS.high; // mid
};
const SORT_LABELS = { campaignName: '캠페인명', cost: '광고비', impressions: '노출', clicks: '클릭', conversions: '전환수', revenue: '전환 매출', cpa: 'CPA', roas: 'ROAS' };

/** 정렬 비교. null(계산 불가)은 방향과 관계없이 항상 맨 아래 */
function compareBy(key, dir) {
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
function ratio(numerator, denominator, multiplier = 1) {
  if (denominator === 0) return null;
  const n = BigInt(numerator) * BigInt(multiplier) * 100n;
  const d = BigInt(denominator);
  return Number((2n * n + d) / (2n * d)) / 100;
}

/** 보이는 캠페인들의 합계 + 지표 (검색·필터 중 합계 행용, 서버와 같은 계산 규칙) */
function sumMetrics(rows) {
  const s = { impressions: 0, clicks: 0, cost: 0, conversions: 0, revenue: 0 };
  for (const row of rows) for (const key of Object.keys(s)) s[key] += row[key];
  return { ...s, ctr: ratio(s.clicks, s.impressions, 100), cpc: ratio(s.cost, s.clicks), cpa: ratio(s.cost, s.conversions), roas: ratio(s.revenue, s.cost, 100) };
}

/**
 * 캠페인 표 그리기
 * 순서: (캠페인 API 실패면 오류만 표시) → ROAS 기준·검색어로 거르기 → 정렬 → 행 → 합계 행
 */
function renderCampaigns() {
  current.shownCampaigns = [];
  current.shownTotal = null;
  campaignCsvBtn.disabled = true;

  // 캠페인 API만 실패: 이 화면에만 오류 + 다시 조회 (이전 목록은 남기지 않음)
  if (current.campaignError) {
    const err = current.campaignError;
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

  const { key, dir } = sortState;
  const keywordRaw = searchInput.value.trim();
  const keyword = keywordRaw.toLowerCase();
  const all = current.campaigns;
  const filtered = Boolean(keyword) || roasBand !== 'all';
  const shown = all.filter((c) => inBand(c, roasBand)
    && (!keyword || c.campaignName.toLowerCase().includes(keyword) || c.campaignId.toLowerCase().includes(keyword)));

  // 정렬 상태 표시 (열 제목의 ↓↑ 화살표는 CSS가 aria-sort를 보고 그림)
  for (const th of campaignTable.querySelectorAll('th[data-key]')) {
    th.setAttribute('aria-sort', th.dataset.key === key ? (dir === 'asc' ? 'ascending' : 'descending') : 'none');
  }
  campaignCaption.textContent = `캠페인 실적, ${SORT_LABELS[key]} ${dir === 'asc' ? '오름차순' : '내림차순'} 정렬`;
  toolbarInfo.textContent = filtered ? `${shown.length}개 / 전체 ${all.length}개` : `전체 ${all.length}개`;
  navCampaignCount.textContent = String(all.length);

  if (shown.length === 0) {
    const td = el('td', { colspan: '9' }, el('div', { text: keyword ? `"${keywordRaw}"에 해당하는 캠페인이 없습니다.` : roasBand !== 'all' ? '선택한 ROAS 기준에 해당하는 캠페인이 없습니다.' : '조회 조건에 해당하는 캠페인이 없습니다.' }));
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
  current.shownCampaigns = sorted; // CSV는 화면에 보이는 순서 그대로
  campaignCsvBtn.disabled = false;
  campaignBody.replaceChildren(...sorted.map((c) => el('tr', {},
    el('td', {}, platformBadge(c.platform)),
    el('th', { scope: 'row', class: 'campaign-name' },
      el('span', { class: 'campaign-title', text: c.campaignName }),
      el('span', { class: 'campaign-id' }, el('span', { class: 'sr-only', text: ', 캠페인 ID ' }), c.campaignId)),
    ...metricCells(c, CAMPAIGN_COLUMNS))));

  // 합계 행: 검색·필터가 없으면 API totals 그대로, 있으면 보이는 캠페인만 합산해 지표 재계산
  const t = filtered ? sumMetrics(shown) : current.totals;
  const totalLabel = filtered ? `필터 결과 합계 (${shown.length}개)` : `전체 합계 (${all.length}개)`;
  current.shownTotal = { label: totalLabel, metrics: t }; // CSV 마지막 행에도 같은 합계
  campaignFoot.replaceChildren(el('tr', {},
    el('th', { scope: 'row', colspan: '2', text: totalLabel }),
    ...metricCells(t, CAMPAIGN_COLUMNS)));
}

// =============================================================================
// 12. 빠른 기간 선택 (7일 · 14일 · 전체)
//    API가 알려 준 데이터 기간(dataRange)의 마지막 날짜 기준 → 날짜를 하드코딩하지 않음
// =============================================================================

/** 빠른 기간 → { start, end }. days=0은 전체(미입력). 최근 N일 = 데이터 마지막 날짜 포함 N일 (데이터 시작일보다 앞으로는 가지 않음) */
function presetRange(days) {
  if (!days || !dataRange.end) return { start: '', end: '' };
  const start = addDays(dataRange.end, -(days - 1));
  return { start: start < dataRange.start ? dataRange.start : start, end: dataRange.end };
}

/** API가 알려준 데이터 기간으로 달력 선택 범위 제한 + 빠른 기간 버튼 활성화 */
function applyDataRange(range) {
  dataRange = range?.start ? range : { start: null, end: null };
  for (const input of [startInput, endInput]) {
    input.min = dataRange.start ?? '2000-01-01';
    input.max = dataRange.end ?? '2099-12-31';
  }
  for (const btn of presetButtons) btn.disabled = !dataRange.end;
}

/** 지금 적용된 조건과 같은 빠른 기간 버튼을 눌린 상태로 표시 (날짜를 직접 고르면 해제) */
function markPreset(filters) {
  // 빠른 기간(7일·14일·전체) → 날짜 칸을 채우고 조회
for (const btn of presetButtons) {
    const days = Number(btn.dataset.days);
    const r = presetRange(days);
    // 전체(0) = 기간 미입력이면 항상 눌림. 7일·14일은 데이터 기간을 알아야 계산 가능
    const on = Boolean(filters && (days === 0 || dataRange.end) && (filters.start || '') === r.start && (filters.end || '') === r.end);
    btn.setAttribute('aria-pressed', String(on));
  }
}

// =============================================================================
// 13. CSV 내보내기 (현재 조회·검색·정렬 결과 그대로)
// =============================================================================

/**
 * CSV 파일 내려받기 (엑셀에서 한글이 깨지지 않도록 UTF-8 BOM 포함)
 * - 숫자는 천 단위 쉼표 없이 원값, null(계산 불가)은 빈 칸
 * - 글자 값이 = + - @ 로 시작하면 앞에 ' 를 붙여 엑셀이 수식으로 실행하지 않게 함 (CSV 수식 주입 방지)
 */
function downloadCsv(filename, header, rows) {
  const cell = (v) => {
    if (v === null || v === undefined) return '';
    let s = String(v);
    if (typeof v === 'string' && /^[=+\-@\t\r]/.test(s)) s = `'${s}`;
    return /[",\r\n]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s;
  };
  const text = `\uFEFF${[header, ...rows].map((r) => r.map(cell).join(',')).join('\r\n')}`;
  const url = URL.createObjectURL(new Blob([text], { type: 'text/csv;charset=utf-8' }));
  const a = el('a', { href: url, download: filename });
  document.body.append(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

/** 파일 이름에 조회 조건을 담음: campaigns_2026-11-01_2026-11-09_meta.csv */
function csvName(prefix) {
  const f = current.filters ?? {};
  return `${prefix}_${f.start || 'all'}_${f.end || 'all'}_${f.platform || 'all-platforms'}.csv`;
}
const METRIC_HEADERS = ['광고비(원)', '노출(회)', '클릭(회)', '전환(건)', '매출(원)', 'CTR(%)', 'CPC(원)', 'CPA(원)', 'ROAS(%)'];
const metricValues = (row) => BRIEF_COLUMNS.map((key) => row[key]);

// =============================================================================
// 14. 화면 전환 (사이드바 메뉴: 성과 요약 / 캠페인 실적)
//    주소의 # 부분(#overview, #campaigns)으로 화면을 정함. 두 화면은 같은 조회 결과를 나눠 보여 주므로 전환 시 API를 다시 부르지 않음
// =============================================================================

const VIEWS = {
  overview: { title: '성과 요약', sub: 'Google · Meta · Naver 광고 성과를 공통 지표로 통합해 보여 줍니다.' },
  campaigns: { title: '캠페인 실적', sub: '열 제목을 누르면 그 기준으로 정렬되고, 캠페인명·ID로 검색할 수 있습니다.' }
};
const navLinks = [...document.querySelectorAll('.side-nav a[data-view]')];
const viewPanels = [...document.querySelectorAll('[data-view-panel]')];

/** 화면 전환: 해당 화면만 보이게 + 메뉴 선택 표시 + 제목 변경. 성과 요약으로 오면 그래프를 새 너비로 다시 그림 */
function showView(name) {
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
  if (view === 'overview' && hasResult) renderTrend();
}

// =============================================================================
// 15. 이벤트 연결 (사용자 동작 → 위 함수 호출을 모두 여기서 연결)
// =============================================================================

// --- 조회 조건 ---

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
  sortState = { key: 'cost', dir: 'desc' };
  roasBand = 'all';
  for (const b of bandButtons) b.setAttribute('aria-pressed', String(b.dataset.band === 'all'));
  load({});
});

// --- 화면 이동 · 오류 ---
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

// --- 성과 요약 ---

// 일별 추이 묶음 버튼 (ROAS & 광고비 / CPA & 전환수)
for (const btn of trendButtons) {
  btn.addEventListener('click', () => {
    trendMode = btn.dataset.mode;
    for (const b of trendButtons) b.setAttribute('aria-pressed', String(b === btn));
    if (hasResult) renderTrend();
  });
}

// 창 크기가 바뀌면 그래프를 새 너비로 다시 그림 (숨겨진 화면에서는 너비를 잴 수 없으므로 건너뜀)
new ResizeObserver(() => { if (hasResult && !trendEl.closest('[hidden]')) renderTrend(); }).observe(trendEl);

// 매체별 표 CSV (매체별 행 + 합계 행)
briefCsvBtn.addEventListener('click', () => {
  downloadCsv(csvName('platform-summary'), ['매체', ...METRIC_HEADERS], [
    ...current.byPlatform.map((p) => [platformName(p.platform), ...metricValues(p)]),
    ['합계', ...metricValues(current.totals)]
  ]);
});

// Esc로 툴팁 닫기 (키보드 사용자도 닫을 수 있게)
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') hideTooltip();
});

// --- 캠페인 실적 ---

// 캠페인 검색 (입력할 때마다 표만 다시 그림, 서버 재호출 없음)
searchInput.addEventListener('input', () => {
  campaignScroll.scrollTop = 0; // 검색어가 바뀌면 목록 맨 위부터
  if (hasResult) renderCampaigns();
});

// ROAS 기준 필터 (전체 · 우수 · 양호 · 주의)
for (const btn of bandButtons) {
  btn.addEventListener('click', () => {
    roasBand = btn.dataset.band;
    for (const b of bandButtons) b.setAttribute('aria-pressed', String(b === btn));
    campaignScroll.scrollTop = 0;
    if (hasResult) renderCampaigns();
  });
}

// 열 제목 클릭 정렬: 다른 열 → 그 열의 기본 방향(숫자는 큰 값부터, 이름은 가나다순) / 같은 열 → 방향 반전
campaignTable.querySelector('thead').addEventListener('click', (e) => {
  const th = e.target.closest('th[data-key]');
  if (!th || !e.target.closest('.th-btn')) return;
  const key = th.dataset.key;
  if (sortState.key === key) sortState = { key, dir: sortState.dir === 'asc' ? 'desc' : 'asc' };
  else sortState = { key, dir: key === 'campaignName' || key === 'cpa' ? 'asc' : 'desc' }; // CPA는 낮을수록 좋으므로 오름차순부터
  campaignScroll.scrollTop = 0; // 정렬이 바뀌면 목록 맨 위부터
  if (hasResult) renderCampaigns();
});

// 캠페인 CSV (지금 보이는 목록 + 합계 행)
campaignCsvBtn.addEventListener('click', () => {
  downloadCsv(csvName('campaigns'), ['매체', '캠페인 ID', '캠페인명', ...METRIC_HEADERS],
    [
      ...current.shownCampaigns.map((c) => [platformName(c.platform), c.campaignId, c.campaignName, ...metricValues(c)]),
      [current.shownTotal.label, '', '', ...metricValues(current.shownTotal.metrics)] // 화면과 같은 합계 행
    ]);
});

// =============================================================================
// 16. 시작: 주소의 화면·조건으로 첫 조회
// =============================================================================

showView(location.hash.slice(1));
const initial = filtersFromURL();
writeForm(initial);
load(initial, { pushHistory: false });
