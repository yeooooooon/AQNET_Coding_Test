/**
 * 광고 성과 대시보드 화면 (바닐라 JS, 외부 라이브러리 없음)
 *
 * 전체 흐름
 *   필터 변경/조회 버튼 → load() → /api/summary, /api/campaigns 동시 호출
 *   → 응답으로 화면 그리기 (요약 카드, 도넛 차트, 매체별 표, 캠페인 표)
 *
 * 보안: 데이터 문자열은 모두 textContent / createElement로만 넣습니다.
 *       innerHTML을 쓰지 않으므로 캠페인명에 <script> 같은 값이 와도 글자로만 표시됩니다(XSS 방지).
 */

const $ = (selector) => document.querySelector(selector);

// =============================================================================
// 1. 화면 요소 · 상수
// =============================================================================

// 사이드바 (필터)
const form = $('#filter-form');
const startInput = $('#start');
const endInput = $('#end');
const submitBtn = $('#submit-btn');
const formError = $('#form-error');

// 상단 · 상태 표시
const statusEl = $('#status');         // 스크린리더용 상태 안내 (화면에는 안 보임)
const updatedEl = $('#updated');       // "마지막 조회 오전 12:30"
const periodEl = $('#period');         // 스크린리더용 현재 조회 조건
const errorBanner = $('#error-banner');
const errorMessage = $('#error-message');
const resultsEl = $('#results');

// 성과 요약 화면
const summaryEl = $('#summary');
const donut = $('#donut');
const donutTotal = $('#donut-total');
const donutDesc = $('#donut-desc');
const legendEl = $('#share-legend');
const platformBody = $('#platform-body');
const platformFoot = $('#platform-foot');

// 캠페인 실적 화면
const campaignTable = $('#campaign-table');
const campaignBody = $('#campaign-body');
const campaignFoot = $('#campaign-foot');
const campaignCaption = $('#campaign-caption');
const campaignCount = $('#campaign-count');
const navCampaignCount = $('#nav-campaign-count');
const toolbarInfo = $('#toolbar-info');
const searchInput = $('#campaign-search');
const tooltip = $('#tooltip');

const PLATFORM_LABELS = { naver: 'Naver', meta: 'Meta', google: 'Google' };
const FILTER_KEYS = ['start', 'end', 'platform'];
const SORT_LABELS = { cost: '광고비', revenue: '전환 매출', conversions: '전환수', roas: 'ROAS', campaignName: '캠페인명' };

// 현재 상태
let current = { summary: null, campaigns: [] };  // 마지막으로 받은 API 응답
let sortState = { key: 'cost', dir: 'desc' };     // 캠페인 표 정렬 (기본: 광고비 내림차순 = API 순서)
let controller = null;                            // 진행 중인 요청 (새 요청이 오면 취소용)

// =============================================================================
// 2. 공통 도우미
// =============================================================================

// 숫자 표시 형식 (값이 null이면 '-')
const nf = new Intl.NumberFormat('ko-KR', { maximumFractionDigits: 2 });   // 1,234.56
const nf1 = new Intl.NumberFormat('ko-KR', { maximumFractionDigits: 1 });  // 점유율용 21.4
const fmt = {
  num: (v) => (v == null ? '-' : nf.format(v)),
  won: (v) => (v == null ? '-' : `${nf.format(v)}원`),
  count: (v) => (v == null ? '-' : `${nf.format(v)}건`),
  times: (v) => (v == null ? '-' : `${nf.format(v)}회`),
  pct: (v) => (v == null ? '-' : `${nf.format(v)}%`)
};

/**
 * 화면 요소를 만드는 함수. el('td', { class: 'num', text: '1,000원' })
 * 글자는 textContent와 텍스트 노드로만 들어가므로 HTML로 해석되지 않습니다.
 */
function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value == null || value === false) continue;
    if (key === 'text') node.textContent = value;
    else if (key === 'class') node.className = value;
    else if (key === 'dataset') Object.assign(node.dataset, value);
    else if (typeof value === 'function' || typeof value === 'number') node[key] = value; // onclick, colSpan 등
    else node.setAttribute(key, value);
  }
  node.append(...children.filter((child) => child != null));
  return node;
}

/** SVG 요소 생성 (도넛 차트용) */
function svg(tag, attrs = {}) {
  const node = document.createElementNS('http://www.w3.org/2000/svg', tag);
  for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, value);
  return node;
}

const platformName = (p) => PLATFORM_LABELS[p] ?? p;

/** 매체 배지 (● Naver) — 색 점과 매체명을 함께 표시해 색만으로 구분하지 않음 */
function platformBadge(platform) {
  return el('span', { class: 'badge', dataset: { platform } },
    el('span', { class: 'dot', 'aria-hidden': 'true' }), platformName(platform));
}

/** 값이 없을 때(분모 0): 화면에는 '-', 스크린리더에는 이유를 읽어 줌 */
function missing(reason = '값 없음') {
  return [el('span', { 'aria-hidden': 'true', text: '-' }), el('span', { class: 'sr-only', text: reason })];
}

// =============================================================================
// 3. 필터 ↔ URL
//    조회 조건을 주소(?start=...&platform=...)에 남겨서
//    새로고침·뒤로가기·링크 공유 시에도 같은 조건이 유지되게 합니다.
// =============================================================================

function readForm() {
  return { start: startInput.value, end: endInput.value, platform: form.elements.platform.value };
}

function writeForm(filters) {
  startInput.value = filters.start || '';
  endInput.value = filters.end || '';
  form.elements.platform.value = PLATFORM_LABELS[filters.platform] ? filters.platform : '';
  syncDateBounds();
}

function filtersFromURL() {
  const params = new URLSearchParams(location.search);
  return Object.fromEntries(FILTER_KEYS.map((key) => [key, params.get(key) || '']));
}

/** { start: '2026-11-01', platform: '' } → "start=2026-11-01" (빈 값은 생략) */
function toQuery(filters) {
  const params = new URLSearchParams();
  for (const key of FILTER_KEYS) if (filters[key]) params.set(key, filters[key]);
  return params.toString();
}

function syncURL(filters) {
  const query = toQuery(filters);
  const search = query ? `?${query}` : '';
  if (search !== location.search) history.pushState(null, '', `${search || location.pathname}${location.hash}`);
}

/** 달력에서 종료일을 시작일보다 앞으로 고를 수 없게 막음 */
function syncDateBounds() {
  endInput.min = startInput.value;
  startInput.max = endInput.value;
}

/** 시작일 > 종료일이면 입력칸 아래에 오류 표시 (서버도 같은 검사를 함) */
function validate(filters) {
  const invalid = Boolean(filters.start && filters.end && filters.start > filters.end);
  startInput.setAttribute('aria-invalid', String(invalid));
  endInput.setAttribute('aria-invalid', String(invalid));
  formError.hidden = !invalid;
  formError.textContent = invalid ? '시작일은 종료일보다 늦을 수 없습니다.' : '';
  return !invalid;
}

/** 스크린리더 안내용 조건 문장: "2026.11.01 ~ 마지막 · Naver" */
function describeFilters(filters) {
  const dot = (d) => d.replaceAll('-', '.');
  const period = filters.start || filters.end
    ? `${filters.start ? dot(filters.start) : '처음'} ~ ${filters.end ? dot(filters.end) : '마지막'}`
    : '전체 기간';
  return `${period} · ${filters.platform ? platformName(filters.platform) : '전체 매체'}`;
}

// =============================================================================
// 4. 데이터 조회
// =============================================================================

/** fetch + JSON 변환. 실패(400/500 등)면 서버가 보낸 message로 에러를 던짐 */
async function fetchJson(path, signal) {
  const res = await fetch(path, { signal, headers: { accept: 'application/json' } });
  let body = null;
  try { body = await res.json(); } catch { /* JSON이 아닌 응답이면 body 없음 */ }
  if (!res.ok) {
    const err = new Error(body?.message || `서버 응답 오류 (HTTP ${res.status})`);
    err.status = res.status;
    throw err;
  }
  return body;
}

/**
 * 조회의 중심 함수: 검증 → URL 반영 → 두 API 동시 호출 → 화면 그리기
 * @param push  true면 URL을 새 기록으로 남김 (뒤로가기로 되돌아올 때는 false)
 */
async function load(filters, { push = true } = {}) {
  hideTooltip();
  if (!validate(filters)) return;
  if (push) syncURL(filters);

  // 이전 요청이 아직 진행 중이면 취소 → 늦게 도착한 옛 응답이 최신 결과를 덮어쓰지 않도록
  controller?.abort();
  const ctrl = new AbortController();
  controller = ctrl;
  setLoading(true);
  errorBanner.hidden = true;

  const query = toQuery(filters);
  const suffix = query ? `?${query}` : '';
  try {
    const [summary, campaigns] = await Promise.all([
      fetchJson(`/api/summary${suffix}`, ctrl.signal),
      fetchJson(`/api/campaigns${suffix}`, ctrl.signal)
    ]);
    current = { summary, campaigns: campaigns.items };

    renderSummary(summary.totals);
    renderShare(summary.byPlatform, summary.totals);
    renderPlatformTable(summary.byPlatform, summary.totals);
    renderCampaigns();

    periodEl.textContent = describeFilters(filters);
    statusEl.textContent = `조회 완료: ${describeFilters(filters)}, 캠페인 ${campaigns.count}개`;
    updatedEl.textContent = `마지막 조회 ${new Date().toLocaleTimeString('ko-KR')}`;
  } catch (error) {
    if (error.name === 'AbortError') return; // 새 요청 때문에 취소된 것 → 무시
    showError(error);
  } finally {
    if (controller === ctrl) {
      controller = null;
      setLoading(false);
    }
  }
}

/** 로딩 표시: 처음엔 회색 자리표시(스켈레톤), 다시 조회할 땐 기존 결과를 흐리게 유지 */
function setLoading(on) {
  submitBtn.disabled = on;
  submitBtn.classList.toggle('is-loading', on);
  submitBtn.querySelector('.btn-label').textContent = on ? '조회 중' : '조회';
  resultsEl.setAttribute('aria-busy', String(on));
  if (on) {
    statusEl.textContent = '데이터를 불러오는 중입니다';
    if (current.summary) resultsEl.classList.add('is-stale');
    else renderSkeleton();
  } else {
    resultsEl.classList.remove('is-stale');
    summaryEl.classList.remove('is-loading');
  }
}

/** 에러 배너 표시. 400(조건 오류)과 서버 연결 실패를 다른 문구로 안내 */
function showError(error) {
  if (error.status === 400) errorMessage.textContent = `조회 조건을 확인해 주세요. (${error.message})`;
  else if (error.status) errorMessage.textContent = error.message;
  else errorMessage.textContent = '서버에 연결할 수 없습니다. 서버 실행 상태와 네트워크를 확인한 뒤 다시 시도해 주세요.';
  errorBanner.hidden = false;
  // 이전 결과가 있으면 그대로 두고 배너로만 안내, 처음부터 실패했으면 빈 화면 표시
  if (!current.summary) renderEmpty('데이터를 불러오지 못했습니다.');
}

// =============================================================================
// 5. 화면 그리기 — 성과 요약
// =============================================================================

/** KPI 카드 하나 채우기 (값이 null이면 '-') */
function setKpi(key, value, unit, note, missingReason) {
  const valueEl = $(`#kpi-${key}`);
  if (value == null) valueEl.replaceChildren(...missing(missingReason));
  else valueEl.replaceChildren(nf.format(value), el('span', { class: 'kpi-unit', text: unit }));
  $(`#kpi-${key}-note`).textContent = note;
}

/** 요약 카드 5개 (문제지 05: 광고비·전환수·매출·CPA·ROAS) + 카드 아래 보조 지표 */
function renderSummary(t) {
  setKpi('cost', t.cost, '원', `클릭 ${fmt.times(t.clicks)} · CPC ${fmt.won(t.cpc)}`);
  setKpi('revenue', t.revenue, '원', `노출 ${fmt.times(t.impressions)} · CTR ${fmt.pct(t.ctr)}`);
  setKpi('conversions', t.conversions, '건', `전환율(CVR) ${fmt.pct(t.cvr)}`);
  setKpi('cpa', t.cpa, '원', t.cpa == null ? '전환이 없어 계산할 수 없음' : '전환 1건당 광고비', '계산 불가, 전환 0건');
  setKpi('roas', t.roas, '%', t.roas == null ? '광고비가 없어 계산할 수 없음' : '광고비 대비 전환 매출', '계산 불가, 광고비 0원');
}

/**
 * 광고비 점유율 도넛 차트 + 범례
 * 원 둘레를 100으로 보고(pathLength=100), 매체별 점유율만큼 선을 이어 그립니다.
 */
function renderShare(byPlatform, totals) {
  donut.replaceChildren(svg('circle', { class: 'track', cx: 60, cy: 60, r: 48 })); // 회색 바탕 원
  donutTotal.textContent = fmt.won(totals.cost);

  const withCost = byPlatform.filter((p) => p.cost > 0);
  if (!totals.cost || withCost.length === 0) {
    legendEl.replaceChildren(el('li', { class: 'empty-inline', text: byPlatform.length ? '광고비가 집행된 매체가 없습니다.' : '조회 조건에 해당하는 데이터가 없습니다.' }));
    donutDesc.textContent = '매체별 광고비 데이터 없음';
    return;
  }

  const share = (p) => (p.cost / totals.cost) * 100;
  const gap = withCost.length > 1 ? 0.8 : 0; // 조각 사이 틈 (색이 붙어 보이지 않게)
  let offset = 0;
  for (const p of withCost) {
    const seg = svg('circle', {
      class: 'seg', cx: 60, cy: 60, r: 48, pathLength: 100,
      'stroke-dasharray': `${Math.max(share(p) - gap, 0.01)} ${100 - share(p) + gap}`, // 그릴 길이, 비울 길이
      'stroke-dashoffset': -offset,                                                // 이전 조각이 끝난 위치부터
      'data-platform': p.platform
    });
    seg.addEventListener('mouseenter', (e) => showTooltip(p, share(p), e.clientX, e.clientY));
    seg.addEventListener('mousemove', (e) => positionTooltip(e.clientX, e.clientY));
    seg.addEventListener('mouseleave', hideTooltip);
    donut.append(seg);
    offset += share(p);
  }

  // 범례: 매체 · 점유율 · 금액 (도넛과 같은 정보를 글자로도 제공)
  legendEl.replaceChildren(...byPlatform.map((p) => el('li', {},
    el('span', { class: 'name', dataset: { platform: p.platform } }, el('span', { class: 'dot', 'aria-hidden': 'true' }), platformName(p.platform)),
    el('span', { class: 'pct', text: `${nf1.format(share(p))}%` }),
    el('span', { class: 'amt', text: fmt.won(p.cost) }))));
  // 스크린리더용 차트 설명
  donutDesc.textContent = `매체별 광고비 점유율: ${byPlatform.map((p) => `${platformName(p.platform)} ${nf1.format(share(p))}%`).join(', ')}`;
}

/** 매체별 지표 표 + 합계 행 (합계는 API totals 그대로) */
function renderPlatformTable(byPlatform, totals) {
  if (byPlatform.length === 0) {
    platformBody.replaceChildren(el('tr', { class: 'empty-row' }, el('td', { colSpan: 6, text: '조회 조건에 해당하는 데이터가 없습니다.' })));
    platformFoot.replaceChildren();
    return;
  }
  const valueOrMissing = (value, format) => (value == null ? missing('계산 불가') : [format(value)]);

  platformBody.replaceChildren(...byPlatform.map((p) => el('tr', {},
    el('th', { scope: 'row' }, platformBadge(p.platform)),
    el('td', { class: 'num strong', text: fmt.won(p.cost) }),
    el('td', { class: 'num', text: fmt.count(p.conversions) }),
    el('td', { class: 'num', text: fmt.won(p.revenue) }),
    el('td', { class: 'num' }, ...valueOrMissing(p.cpa, fmt.won)),
    el('td', { class: 'num strong' }, ...valueOrMissing(p.roas, fmt.pct)))));

  platformFoot.replaceChildren(el('tr', {},
    el('td', { text: '합계' }),
    el('td', { class: 'num', text: fmt.won(totals.cost) }),
    el('td', { class: 'num', text: fmt.count(totals.conversions) }),
    el('td', { class: 'num', text: fmt.won(totals.revenue) }),
    el('td', { class: 'num' }, ...valueOrMissing(totals.cpa, fmt.won)),
    el('td', { class: 'num' }, ...valueOrMissing(totals.roas, fmt.pct))));
}

// 도넛 툴팁 (마우스를 올리면 매체별 상세 지표). Esc 또는 마우스를 떼면 닫힘.
function showTooltip(p, share, x, y) {
  const rows = [['점유율', `${nf1.format(share)}%`], ['광고비', fmt.won(p.cost)], ['전환', fmt.count(p.conversions)],
    ['매출', fmt.won(p.revenue)], ['CPA', fmt.won(p.cpa)], ['ROAS', fmt.pct(p.roas)]];
  tooltip.replaceChildren(
    el('strong', { dataset: { platform: p.platform } }, el('span', { class: 'dot', 'aria-hidden': 'true' }), platformName(p.platform)),
    el('dl', {}, ...rows.flatMap(([label, value]) => [el('dt', { text: label }), el('dd', { text: value })])));
  tooltip.hidden = false;
  positionTooltip(x, y);
}

/** 마우스 옆에 툴팁 배치 (화면 밖으로 나가지 않게) */
function positionTooltip(x, y) {
  const pad = 14;
  const { width, height } = tooltip.getBoundingClientRect();
  const left = Math.min(x + pad, window.innerWidth - width - 8);
  const top = y + pad + height > window.innerHeight ? y - height - pad : y + pad;
  tooltip.style.left = `${Math.max(8, left)}px`;
  tooltip.style.top = `${Math.max(8, top)}px`;
}

function hideTooltip() {
  tooltip.hidden = true;
}

// =============================================================================
// 6. 화면 그리기 — 캠페인 실적 (검색 + 정렬)
//    API가 준 목록을 화면에서만 걸러내고 정렬합니다(서버 재호출 없음).
// =============================================================================

/** 정렬 비교 함수. null(분모 0이라 계산 불가)은 방향과 관계없이 항상 맨 아래 */
function compareBy(key, dir) {
  return (a, b) => {
    const av = a[key];
    const bv = b[key];
    if (av == null && bv == null) return 0;
    if (av == null) return 1;
    if (bv == null) return -1;
    const diff = typeof av === 'number' ? av - bv : String(av).localeCompare(String(bv), 'ko');
    return dir === 'asc' ? diff : -diff;
  };
}

/** 검색 결과 행들의 기본 지표 합계 */
function sumRows(rows) {
  const sums = { impressions: 0, clicks: 0, cost: 0, conversions: 0, revenue: 0 };
  for (const row of rows) for (const key of Object.keys(sums)) sums[key] += row[key];
  return sums;
}

function renderCampaigns() {
  const { key, dir } = sortState;
  const keywordRaw = searchInput.value.trim();
  const keyword = keywordRaw.toLowerCase();
  const all = current.campaigns;
  const shown = keyword
    ? all.filter((c) => c.campaignName.toLowerCase().includes(keyword) || c.campaignId.toLowerCase().includes(keyword))
    : all;

  // 정렬 상태 표시 (열 제목의 ↓↑ 화살표는 CSS가 aria-sort를 보고 그림)
  for (const th of campaignTable.querySelectorAll('th[data-key]')) {
    th.setAttribute('aria-sort', th.dataset.key === key ? (dir === 'asc' ? 'ascending' : 'descending') : 'none');
  }

  // 개수 표시 (표 위, 사이드바 메뉴, 스크린리더용)
  campaignCaption.textContent = `캠페인 실적, ${SORT_LABELS[key]} ${dir === 'asc' ? '오름차순' : '내림차순'} 정렬${keyword ? `, "${keywordRaw}" 검색 결과 ${shown.length}개` : ''}`;
  campaignCount.textContent = keyword ? `${shown.length} / ${all.length}` : String(all.length);
  navCampaignCount.textContent = String(all.length);
  toolbarInfo.textContent = keyword ? `검색 결과 ${shown.length}개 / 전체 ${all.length}개` : `전체 ${all.length}개`;

  // 결과 없음
  if (shown.length === 0) {
    const td = el('td', { colSpan: 7 },
      el('div', { text: keyword ? `"${keywordRaw}"에 해당하는 캠페인이 없습니다.` : '조회 조건에 해당하는 캠페인이 없습니다.' }));
    td.append(keyword
      ? el('button', { type: 'button', class: 'btn btn-ghost btn-sm', text: '검색어 지우기', onclick: () => { searchInput.value = ''; renderCampaigns(); searchInput.focus(); } })
      : el('button', { type: 'button', class: 'btn btn-ghost btn-sm', text: '필터 초기화', onclick: resetFilters }));
    campaignBody.replaceChildren(el('tr', { class: 'empty-row' }, td));
    campaignFoot.replaceChildren();
    return;
  }

  // 표 본문. sort()는 안정 정렬이라 값이 같으면 API 순서(광고비 → 매체 → ID)가 유지됨
  const sorted = [...shown].sort(compareBy(key, dir));
  campaignBody.replaceChildren(...sorted.map((c) => el('tr', {},
    el('td', {}, platformBadge(c.platform)),
    el('th', { scope: 'row', class: 'campaign-name' },
      el('span', { class: 'campaign-title', text: c.campaignName }),
      el('span', { class: 'campaign-id' }, el('span', { class: 'sr-only', text: ', 캠페인 ID ' }), c.campaignId)),
    el('td', { class: 'num strong', text: fmt.won(c.cost) }),
    el('td', { class: 'num sub-num', text: `${fmt.num(c.impressions)}회 / ${fmt.num(c.clicks)}클릭` }),
    el('td', { class: 'num', text: fmt.count(c.conversions) }),
    el('td', { class: 'num', text: fmt.won(c.revenue) }),
    el('td', { class: 'num' }, c.roas == null
      ? el('span', { class: 'roas-pill is-empty', title: '광고비가 0원이라 ROAS를 계산할 수 없습니다.' }, ...missing('계산 불가, 광고비 0원'))
      : el('span', { class: 'roas-pill', text: fmt.pct(c.roas) })))));

  // 합계 행: 검색 없으면 API totals 그대로, 검색 중이면 보이는 행만 합산해 ROAS 다시 계산
  const t = keyword ? sumRows(shown) : current.summary.totals;
  const roas = keyword ? (t.cost ? Math.round((t.revenue / t.cost) * 10000) / 100 : null) : t.roas;
  campaignFoot.replaceChildren(el('tr', {},
    el('td', { colSpan: 2, text: keyword ? `검색 결과 합계 (${shown.length}개)` : `전체 합계 (${all.length}개)` }),
    el('td', { class: 'num', text: fmt.won(t.cost) }),
    el('td', { class: 'num sub-num', text: `${fmt.num(t.impressions)}회 / ${fmt.num(t.clicks)}클릭` }),
    el('td', { class: 'num', text: fmt.count(t.conversions) }),
    el('td', { class: 'num', text: fmt.won(t.revenue) }),
    el('td', { class: 'num', text: fmt.pct(roas) })));
}

// =============================================================================
// 7. 로딩 · 빈 상태
// =============================================================================

/** 첫 로딩: 카드와 표에 회색 자리표시 */
function renderSkeleton() {
  summaryEl.classList.add('is-loading');
  legendEl.replaceChildren();
  donut.replaceChildren(svg('circle', { class: 'track', cx: 60, cy: 60, r: 48 }));
  donutTotal.textContent = '-';
  const skeletonRows = (cols, count) => Array.from({ length: count }, () =>
    el('tr', { class: 'skeleton-row', 'aria-hidden': 'true' }, ...Array.from({ length: cols }, () => el('td', {}, el('span')))));
  platformBody.replaceChildren(...skeletonRows(6, 3));
  platformFoot.replaceChildren();
  campaignBody.replaceChildren(...skeletonRows(7, 5));
  campaignFoot.replaceChildren();
}

/** 처음부터 조회에 실패했을 때: 모든 영역을 비우고 안내 문구 표시 */
function renderEmpty(message) {
  summaryEl.classList.remove('is-loading');
  for (const key of ['cost', 'revenue', 'conversions', 'cpa', 'roas']) setKpi(key, null, '', '');
  periodEl.textContent = '-';
  donut.replaceChildren(svg('circle', { class: 'track', cx: 60, cy: 60, r: 48 }));
  donutTotal.textContent = '-';
  legendEl.replaceChildren(el('li', { class: 'empty-inline', text: message }));
  platformBody.replaceChildren(el('tr', { class: 'empty-row' }, el('td', { colSpan: 6, text: message })));
  platformFoot.replaceChildren();
  campaignBody.replaceChildren(el('tr', { class: 'empty-row' }, el('td', { colSpan: 7, text: message })));
  campaignFoot.replaceChildren();
  campaignCount.textContent = '';
  navCampaignCount.textContent = '';
  toolbarInfo.textContent = '';
}

// =============================================================================
// 8. 화면 전환 (사이드바 메뉴: 성과 요약 / 캠페인 실적)
//    주소의 # 부분(#overview, #campaigns)으로 화면을 정해서 새로고침해도 같은 화면 유지
// =============================================================================

const VIEWS = {
  overview: { title: '성과 요약', sub: 'Naver · Meta · Google 광고 성과를 공통 지표로 통합해 보여 줍니다.' },
  campaigns: { title: '캠페인 실적', sub: '열 제목을 누르면 그 기준으로 정렬됩니다.' }
};
const navLinks = [...document.querySelectorAll('.side-nav a[data-view]')];
const viewPanels = [...document.querySelectorAll('[data-view-panel]')];

function showView(name, { focus = false } = {}) {
  const view = VIEWS[name] ? name : 'overview';
  for (const panel of viewPanels) panel.hidden = panel.dataset.viewPanel !== view;
  for (const link of navLinks) {
    if (link.dataset.view === view) link.setAttribute('aria-current', 'page'); // 선택된 메뉴 표시
    else link.removeAttribute('aria-current');
  }
  $('#view-title').textContent = VIEWS[view].title;
  $('#view-sub').textContent = VIEWS[view].sub;
  document.title = `${VIEWS[view].title} | 광고 성과 통합 대시보드`;
  hideTooltip();
  // 메뉴를 눌러 바꾼 경우: 맨 위로 + 본문으로 포커스 이동 (키보드·스크린리더 사용자용)
  if (focus) {
    window.scrollTo(0, 0);
    $('#main').focus({ preventScroll: true });
  }
}

// =============================================================================
// 9. 이벤트 연결
// =============================================================================

/** 초기화: 필터·검색·정렬을 모두 기본값으로 되돌리고 전체 조회 */
function resetFilters() {
  writeForm({});
  searchInput.value = '';
  sortState = { key: 'cost', dir: 'desc' };
  load({});
}

// 조회 버튼 (문제지 05: 조회 버튼 동작)
form.addEventListener('submit', (e) => {
  e.preventDefault();
  load(readForm());
});

// 초기화 버튼: 브라우저 기본 reset 대신 직접 처리 (검색·정렬·URL까지 초기화하기 위해)
form.addEventListener('reset', (e) => {
  e.preventDefault();
  resetFilters();
});

// 매체·날짜를 바꾸면 조회 버튼 없이 바로 반영
form.addEventListener('change', (e) => {
  if (e.target.name === 'platform' || e.target.type === 'date') {
    syncDateBounds();
    load(readForm());
  }
});

// 에러 배너의 "다시 시도"
$('#retry-btn').addEventListener('click', () => load(readForm(), { push: false }));

// 캠페인 검색 (입력할 때마다 표만 다시 그림)
searchInput.addEventListener('input', () => {
  if (current.summary) renderCampaigns();
});

// 열 제목 클릭 정렬: 다른 열 → 그 열의 기본 방향 / 같은 열 → 방향 반전
campaignTable.querySelector('thead').addEventListener('click', (e) => {
  const th = e.target.closest('th[data-key]');
  if (!th || !e.target.closest('.th-btn')) return;
  const key = th.dataset.key;
  if (sortState.key === key) sortState = { key, dir: sortState.dir === 'asc' ? 'desc' : 'asc' };
  else sortState = { key, dir: key === 'campaignName' ? 'asc' : 'desc' }; // 숫자는 큰 값부터, 이름은 가나다순
  if (current.summary) renderCampaigns();
});

// 메뉴 클릭(주소의 # 변경) → 화면 전환
window.addEventListener('hashchange', () => showView(location.hash.slice(1), { focus: true }));

// 브라우저 뒤로/앞으로 → 주소의 조건으로 필터를 되돌리고 다시 조회
window.addEventListener('popstate', () => {
  const filters = filtersFromURL();
  writeForm(filters);
  load(filters, { push: false });
});

// Esc로 툴팁 닫기 (접근성: 키보드 사용자도 닫을 수 있어야 함)
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') hideTooltip();
});

// =============================================================================
// 10. 시작: 주소의 화면·조건으로 첫 화면을 그림 (조건이 없으면 전체 조회)
// =============================================================================

showView(location.hash.slice(1));
const initialFilters = filtersFromURL();
writeForm(initialFilters);
load(initialFilters, { push: false });
