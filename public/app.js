// 광고 성과 통합 대시보드 프론트엔드 (외부 라이브러리 없음)
// - 필터(시작일/종료일/매체) ↔ URL 쿼리 동기화 → /api/summary, /api/campaigns 병렬 호출
// - KPI 카드, 매체별 점유율 도넛 + 성과 표, 캠페인 표(검색·정렬·합계)
// - 로딩(스켈레톤)·에러(배너+다시 시도)·빈 결과 상태
// - 사이드바 메뉴로 화면 전환(성과 요약 / 캠페인 실적), URL 해시(#overview, #campaigns)에 반영
// - 데이터 문자열은 모두 textContent / createElement(NS)로 렌더링 (innerHTML 미사용 → XSS 방지)

const $ = (sel) => document.querySelector(sel);

const form = $('#filter-form');
const startInput = $('#start');
const endInput = $('#end');
const submitBtn = $('#submit-btn');
const formError = $('#form-error');
const statusEl = $('#status');
const updatedEl = $('#updated');
const errorBanner = $('#error-banner');
const errorMessage = $('#error-message');
const resultsEl = $('#results');
const periodEl = $('#period');
const summaryEl = $('#summary');
const donut = $('#donut');
const donutTotal = $('#donut-total');
const donutDesc = $('#donut-desc');
const legendEl = $('#share-legend');
const platformBody = $('#platform-body');
const platformFoot = $('#platform-foot');
const campaignTable = $('#campaign-table');
const campaignBody = $('#campaign-body');
const campaignFoot = $('#campaign-foot');
const campaignCaption = $('#campaign-caption');
const campaignCount = $('#campaign-count');
const navCampaignCount = $('#nav-campaign-count');
const searchInput = $('#campaign-search');
const toolbarInfo = $('#toolbar-info');
const tooltip = $('#tooltip');

const PLATFORM_LABELS = { naver: 'Naver', meta: 'Meta', google: 'Google' };
const FILTER_KEYS = ['start', 'end', 'platform'];
const SVG_NS = 'http://www.w3.org/2000/svg';
const SORT_LABELS = { cost: '광고비', revenue: '전환 매출', conversions: '전환수', roas: 'ROAS', campaignName: '캠페인명' };
// 기본 정렬 방향: 숫자는 큰 값부터, 캠페인명은 가나다순. 같은 열을 다시 누르면 방향 반전.
const defaultDir = (key) => (key === 'campaignName' ? 'asc' : 'desc');
let sortState = { key: 'cost', dir: 'desc' };

// ---------------------------------------------------------------------------
// 포맷터 (null → '-')
// ---------------------------------------------------------------------------
const nf = new Intl.NumberFormat('ko-KR', { maximumFractionDigits: 2 });
const nf1 = new Intl.NumberFormat('ko-KR', { maximumFractionDigits: 1 });
const fmt = {
  num: (v) => (v == null ? '-' : nf.format(v)),
  won: (v) => (v == null ? '-' : `${nf.format(v)}원`),
  count: (v) => (v == null ? '-' : `${nf.format(v)}건`),
  times: (v) => (v == null ? '-' : `${nf.format(v)}회`),
  pct: (v) => (v == null ? '-' : `${nf.format(v)}%`)
};

// ---------------------------------------------------------------------------
// DOM 헬퍼: 문자열 자식은 텍스트 노드로 들어가므로 HTML로 해석되지 않습니다.
// ---------------------------------------------------------------------------
function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v == null || v === false) continue;
    if (k === 'text') node.textContent = v;
    else if (k === 'class') node.className = v;
    else if (k === 'dataset') Object.assign(node.dataset, v);
    else if (typeof v === 'function' || typeof v === 'number') node[k] = v;
    else node.setAttribute(k, v);
  }
  node.append(...children.filter((c) => c != null));
  return node;
}

function svg(tag, attrs = {}) {
  const node = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
  return node;
}

const platformName = (p) => PLATFORM_LABELS[p] ?? p;

function platformBadge(platform) {
  return el('span', { class: 'badge', dataset: { platform } },
    el('span', { class: 'dot', 'aria-hidden': 'true' }), platformName(platform));
}

// 값이 없을 때: 화면에는 '-', 스크린리더에는 사유를 읽어 줌
function missing(reason = '값 없음') {
  return [el('span', { 'aria-hidden': 'true', text: '-' }), el('span', { class: 'sr-only', text: reason })];
}

// ---------------------------------------------------------------------------
// 필터 상태 ↔ 폼 ↔ URL
// ---------------------------------------------------------------------------
function readForm() {
  return { start: startInput.value || '', end: endInput.value || '', platform: form.elements.platform.value || '' };
}

function writeForm(filters) {
  startInput.value = filters.start || '';
  endInput.value = filters.end || '';
  form.elements.platform.value = PLATFORM_LABELS[filters.platform] ? filters.platform : '';
  syncDateBounds();
}

function filtersFromURL() {
  const params = new URLSearchParams(location.search);
  return Object.fromEntries(FILTER_KEYS.map((k) => [k, params.get(k) || '']));
}

function toQuery(filters) {
  const params = new URLSearchParams();
  for (const k of FILTER_KEYS) if (filters[k]) params.set(k, filters[k]);
  return params.toString();
}

// 조회 조건을 URL에 반영 → 새로고침·링크 공유·뒤로가기 시 같은 조건 유지
function syncURL(filters) {
  const query = toQuery(filters);
  const search = query ? `?${query}` : '';
  if (search !== location.search) history.pushState(null, '', `${search || location.pathname}${location.hash}`);
}

// 달력에서 종료일 < 시작일을 고를 수 없도록 상호 제한
function syncDateBounds() {
  endInput.min = startInput.value || '';
  startInput.max = endInput.value || '';
}

function validate(filters) {
  const invalid = Boolean(filters.start && filters.end && filters.start > filters.end);
  startInput.setAttribute('aria-invalid', String(invalid));
  endInput.setAttribute('aria-invalid', String(invalid));
  formError.hidden = !invalid;
  formError.textContent = invalid ? '시작일은 종료일보다 늦을 수 없습니다.' : '';
  return !invalid;
}

function describeFilters(filters) {
  const dot = (d) => d.replaceAll('-', '.');
  const period = filters.start || filters.end
    ? `${filters.start ? dot(filters.start) : '처음'} ~ ${filters.end ? dot(filters.end) : '마지막'}`
    : '전체 기간';
  return `${period} · ${filters.platform ? platformName(filters.platform) : '전체 매체'}`;
}

// ---------------------------------------------------------------------------
// API
// ---------------------------------------------------------------------------
async function fetchJson(path, signal) {
  const res = await fetch(path, { signal, headers: { accept: 'application/json' } });
  let body = null;
  try { body = await res.json(); } catch { /* JSON이 아닌 응답 */ }
  if (!res.ok) {
    const err = new Error(body?.message || `서버 응답 오류 (HTTP ${res.status})`);
    err.status = res.status;
    throw err;
  }
  return body;
}

let controller = null;
let current = { filters: {}, summary: null, campaigns: [] };

async function load(filters, { push = true } = {}) {
  hideTooltip();
  if (!validate(filters)) return;
  if (push) syncURL(filters);

  // 이전 요청 취소 → 늦게 도착한 응답이 최신 결과를 덮어쓰지 않도록
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
    current = { filters, summary, campaigns: campaigns.items };
    periodEl.textContent = describeFilters(filters);
    renderSummary(summary.totals);
    renderShare(summary.byPlatform, summary.totals);
    renderPlatformTable(summary.byPlatform, summary.totals);
    renderCampaigns();
    statusEl.textContent = `조회 완료: ${describeFilters(filters)}, 캠페인 ${campaigns.count}개`;
    updatedEl.textContent = `마지막 조회 ${new Date().toLocaleTimeString('ko-KR')}`;
  } catch (error) {
    if (error.name === 'AbortError') return;
    showError(error);
  } finally {
    if (controller === ctrl) {
      controller = null;
      setLoading(false);
    }
  }
}

function setLoading(on) {
  submitBtn.disabled = on;
  submitBtn.classList.toggle('is-loading', on);
  submitBtn.querySelector('.btn-label').textContent = on ? '조회 중' : '조회';
  resultsEl.setAttribute('aria-busy', String(on));
  if (on) {
    statusEl.textContent = '데이터를 불러오는 중입니다';
    // 최초 로딩은 스켈레톤, 재조회는 기존 결과를 흐리게 유지 (화면 흔들림 방지)
    if (current.summary) resultsEl.classList.add('is-stale');
    else renderSkeleton();
  } else {
    resultsEl.classList.remove('is-stale');
    summaryEl.classList.remove('is-loading');
  }
}

function showError(error) {
  errorMessage.textContent = error.status === 400
    ? `조회 조건을 확인해 주세요. (${error.message})`
    : error.status
      ? error.message
      : '서버에 연결할 수 없습니다. 서버 실행 상태와 네트워크를 확인한 뒤 다시 시도해 주세요.';
  errorBanner.hidden = false;
  // 이전 결과가 있으면 그대로 두고(배너로 안내), 없으면 빈 상태 표시
  if (!current.summary) renderEmpty('데이터를 불러오지 못했습니다.');
}

// ---------------------------------------------------------------------------
// KPI
// ---------------------------------------------------------------------------
function setKpi(key, value, unit, note, missingReason) {
  const valueEl = $(`#kpi-${key}`);
  if (value == null) valueEl.replaceChildren(...missing(missingReason));
  else valueEl.replaceChildren(nf.format(value), el('span', { class: 'kpi-unit', text: unit }));
  $(`#kpi-${key}-note`).textContent = note;
}

function renderSummary(t) {
  setKpi('cost', t.cost, '원', `클릭 ${fmt.times(t.clicks)} · CPC ${fmt.won(t.cpc)}`);
  setKpi('revenue', t.revenue, '원', `노출 ${fmt.times(t.impressions)} · CTR ${fmt.pct(t.ctr)}`);
  setKpi('conversions', t.conversions, '건', `전환율(CVR) ${fmt.pct(t.cvr)}`);
  setKpi('cpa', t.cpa, '원', t.cpa == null ? '전환이 없어 계산할 수 없음' : '전환 1건당 광고비', '계산 불가, 전환 0건');
  setKpi('roas', t.roas, '%', t.roas == null ? '광고비가 없어 계산할 수 없음' : '광고비 대비 전환 매출', '계산 불가, 광고비 0원');
}

// ---------------------------------------------------------------------------
// 매체별 광고비 점유율 (도넛 + 범례)
// ---------------------------------------------------------------------------
function renderShare(byPlatform, totals) {
  donut.replaceChildren(svg('circle', { class: 'track', cx: 60, cy: 60, r: 48 }));
  donutTotal.textContent = fmt.won(totals.cost);

  const withCost = byPlatform.filter((p) => p.cost > 0);
  if (!totals.cost || withCost.length === 0) {
    legendEl.replaceChildren(el('li', { class: 'empty-inline', text: byPlatform.length ? '광고비가 집행된 매체가 없습니다.' : '조회 조건에 해당하는 데이터가 없습니다.' }));
    donutDesc.textContent = '매체별 광고비 데이터 없음';
    return;
  }

  // pathLength=100 기준으로 조각을 이어 그림. 조각 사이 틈(gap)으로 인접 색을 분리.
  const gap = withCost.length > 1 ? 0.8 : 0;
  let offset = 0;
  for (const p of withCost) {
    const share = (p.cost / totals.cost) * 100;
    const seg = svg('circle', {
      class: 'seg', cx: 60, cy: 60, r: 48, pathLength: 100,
      'stroke-dasharray': `${Math.max(share - gap, 0.01)} ${100 - share + gap}`,
      'stroke-dashoffset': -offset,
      'data-platform': p.platform
    });
    seg.addEventListener('mouseenter', (e) => showTooltip(p, share, e.clientX, e.clientY));
    seg.addEventListener('mousemove', (e) => positionTooltip(e.clientX, e.clientY));
    seg.addEventListener('mouseleave', hideTooltip);
    donut.append(seg);
    offset += share;
  }

  legendEl.replaceChildren(...byPlatform.map((p) => {
    const share = totals.cost ? (p.cost / totals.cost) * 100 : 0;
    return el('li', {},
      el('span', { class: 'name', dataset: { platform: p.platform } }, el('span', { class: 'dot', 'aria-hidden': 'true' }), platformName(p.platform)),
      el('span', { class: 'pct', text: `${nf1.format(share)}%` }),
      el('span', { class: 'amt', text: fmt.won(p.cost) }));
  }));
  donutDesc.textContent = `매체별 광고비 점유율: ${byPlatform.map((p) =>
    `${platformName(p.platform)} ${nf1.format(totals.cost ? (p.cost / totals.cost) * 100 : 0)}%`).join(', ')}`;
}

function showTooltip(p, share, x, y) {
  const rows = [['점유율', `${nf1.format(share)}%`], ['광고비', fmt.won(p.cost)], ['전환', fmt.count(p.conversions)],
    ['매출', fmt.won(p.revenue)], ['CPA', fmt.won(p.cpa)], ['ROAS', fmt.pct(p.roas)]];
  tooltip.replaceChildren(
    el('strong', { dataset: { platform: p.platform } }, el('span', { class: 'dot', 'aria-hidden': 'true' }), platformName(p.platform)),
    el('dl', {}, ...rows.flatMap(([k, v]) => [el('dt', { text: k }), el('dd', { text: v })])));
  tooltip.hidden = false;
  positionTooltip(x, y);
}

function positionTooltip(x, y) {
  const pad = 14;
  const { width, height } = tooltip.getBoundingClientRect();
  const left = Math.min(x + pad, window.innerWidth - width - 8);
  const top = y + pad + height > window.innerHeight ? y - height - pad : y + pad;
  tooltip.style.left = `${Math.max(8, left)}px`;
  tooltip.style.top = `${Math.max(8, top)}px`;
}

function hideTooltip() { tooltip.hidden = true; }

// ---------------------------------------------------------------------------
// 매체별 성과 표
// ---------------------------------------------------------------------------
function renderPlatformTable(byPlatform, totals) {
  if (byPlatform.length === 0) {
    platformBody.replaceChildren(el('tr', { class: 'empty-row' }, el('td', { colSpan: 6, text: '조회 조건에 해당하는 데이터가 없습니다.' })));
    platformFoot.replaceChildren();
    return;
  }
  // 합계 행: API totals 그대로 (비율도 원본 합계 기준)
  platformFoot.replaceChildren(el('tr', {},
    el('td', { text: '합계' }),
    el('td', { class: 'num', text: fmt.won(totals.cost) }),
    el('td', { class: 'num', text: fmt.count(totals.conversions) }),
    el('td', { class: 'num', text: fmt.won(totals.revenue) }),
    el('td', { class: 'num' }, ...(totals.cpa == null ? missing('계산 불가') : [fmt.won(totals.cpa)])),
    el('td', { class: 'num' }, ...(totals.roas == null ? missing('계산 불가') : [fmt.pct(totals.roas)]))));
  platformBody.replaceChildren(...byPlatform.map((p) => el('tr', {},
    el('th', { scope: 'row' }, platformBadge(p.platform)),
    el('td', { class: 'num strong', text: fmt.won(p.cost) }),
    el('td', { class: 'num', text: fmt.count(p.conversions) }),
    el('td', { class: 'num', text: fmt.won(p.revenue) }),
    el('td', { class: 'num' }, ...(p.cpa == null ? missing('계산 불가') : [fmt.won(p.cpa)])),
    el('td', { class: 'num strong' }, ...(p.roas == null ? missing('계산 불가') : [fmt.pct(p.roas)])))));
}

// ---------------------------------------------------------------------------
// 캠페인 표 (검색 + 정렬)
// ---------------------------------------------------------------------------
function compareBy(key, dir) {
  const asc = dir === 'asc';
  return (a, b) => {
    const av = a[key];
    const bv = b[key];
    // null(분모 0 지표)은 정렬 방향과 무관하게 항상 맨 아래
    if (av == null && bv == null) return 0;
    if (av == null) return 1;
    if (bv == null) return -1;
    const base = typeof av === 'number' ? av - bv : String(av).localeCompare(String(bv), 'ko');
    return asc ? base : -base;
  };
}

function sumRows(rows) {
  const s = { impressions: 0, clicks: 0, cost: 0, conversions: 0, revenue: 0 };
  for (const r of rows) for (const k of Object.keys(s)) s[k] += r[k];
  return s;
}

function renderCampaigns() {
  const { key, dir } = sortState;
  const keyword = searchInput.value.trim().toLowerCase();
  const all = current.campaigns;
  const shown = keyword
    ? all.filter((c) => c.campaignName.toLowerCase().includes(keyword) || c.campaignId.toLowerCase().includes(keyword))
    : all;

  for (const th of campaignTable.querySelectorAll('th[data-key]')) {
    th.setAttribute('aria-sort', th.dataset.key === key ? (dir === 'asc' ? 'ascending' : 'descending') : 'none');
  }
  campaignCaption.textContent = `캠페인 실적, ${SORT_LABELS[key]} ${dir === 'asc' ? '오름차순' : '내림차순'} 정렬${keyword ? `, "${searchInput.value.trim()}" 검색 결과 ${shown.length}개` : ''}`;
  campaignCount.textContent = keyword ? `${shown.length} / ${all.length}` : String(all.length);
  navCampaignCount.textContent = String(all.length);
  toolbarInfo.textContent = keyword ? `검색 결과 ${shown.length}개 / 전체 ${all.length}개` : `전체 ${all.length}개`;

  if (shown.length === 0) {
    const td = el('td', { colSpan: 7 },
      el('div', { text: keyword ? `"${searchInput.value.trim()}"에 해당하는 캠페인이 없습니다.` : '조회 조건에 해당하는 캠페인이 없습니다.' }));
    td.append(keyword
      ? el('button', { type: 'button', class: 'btn btn-ghost btn-sm', text: '검색어 지우기', onclick: () => { searchInput.value = ''; renderCampaigns(); searchInput.focus(); } })
      : el('button', { type: 'button', class: 'btn btn-ghost btn-sm', text: '필터 초기화', onclick: resetFilters }));
    campaignBody.replaceChildren(el('tr', { class: 'empty-row' }, td));
    campaignFoot.replaceChildren();
    return;
  }

  // Array.prototype.sort는 안정 정렬 → 동점이면 API 순서(광고비 → 매체 → 캠페인 ID) 유지
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

  // 합계: 검색이 없으면 API totals 그대로, 검색 중이면 보이는 행의 원본 합계로 ROAS 계산
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

// ---------------------------------------------------------------------------
// 로딩 / 빈 상태
// ---------------------------------------------------------------------------
function renderSkeleton() {
  summaryEl.classList.add('is-loading');
  legendEl.replaceChildren();
  donut.replaceChildren(svg('circle', { class: 'track', cx: 60, cy: 60, r: 48 }));
  donutTotal.textContent = '-';
  const skeletonRows = (cols, n) => Array.from({ length: n }, () =>
    el('tr', { class: 'skeleton-row', 'aria-hidden': 'true' }, ...Array.from({ length: cols }, () => el('td', {}, el('span')))));
  platformBody.replaceChildren(...skeletonRows(6, 3));
  platformFoot.replaceChildren();
  campaignBody.replaceChildren(...skeletonRows(7, 5));
  campaignFoot.replaceChildren();
}

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

// ---------------------------------------------------------------------------
// 이벤트
// ---------------------------------------------------------------------------
function resetFilters() {
  writeForm({});
  searchInput.value = '';
  sortState = { key: 'cost', dir: 'desc' };
  load({});
}

form.addEventListener('submit', (e) => {
  e.preventDefault();
  load(readForm());
});

form.addEventListener('reset', (e) => {
  e.preventDefault(); // 기본 reset 대신 검색·정렬·URL까지 함께 초기화
  resetFilters();
});

// 매체·날짜를 바꾸면 조회 버튼을 누르지 않아도 바로 반영 (조회 버튼은 재조회용으로 유지)
form.addEventListener('change', (e) => {
  if (e.target.name === 'platform' || e.target.type === 'date') {
    syncDateBounds();
    load(readForm());
  }
});

searchInput.addEventListener('input', () => { if (current.summary) renderCampaigns(); });

// 열 제목 클릭 정렬: 다른 열 → 그 열 기본 방향, 같은 열 → 방향 반전
campaignTable.querySelector('thead').addEventListener('click', (e) => {
  const th = e.target.closest('th[data-key]');
  if (!th || !e.target.closest('.th-btn')) return;
  const key = th.dataset.key;
  sortState = sortState.key === key
    ? { key, dir: sortState.dir === 'asc' ? 'desc' : 'asc' }
    : { key, dir: defaultDir(key) };
  if (current.summary) renderCampaigns();
});

// ---------------------------------------------------------------------------
// 사이드바 화면 전환 (해시 기반: 새로고침·뒤로가기·링크 공유 시 같은 화면 유지)
// ---------------------------------------------------------------------------
const VIEWS = {
  overview: { title: '성과 요약', sub: 'Naver · Meta · Google 광고 성과를 공통 지표로 통합해 보여 줍니다.' },
  campaigns: { title: '캠페인 실적', sub: '열 제목을 누르면 그 기준으로 정렬됩니다.' }
};
const navLinks = [...document.querySelectorAll('.side-nav a[data-view]')];
const viewPanels = [...document.querySelectorAll('[data-view-panel]')];

function showView(name, { focus = false } = {}) {
  const view = VIEWS[name] ? name : 'overview';
  for (const panel of viewPanels) panel.hidden = panel.dataset.viewPanel !== view;
  for (const a of navLinks) {
    if (a.dataset.view === view) a.setAttribute('aria-current', 'page');
    else a.removeAttribute('aria-current');
  }
  $('#view-title').textContent = VIEWS[view].title;
  $('#view-sub').textContent = VIEWS[view].sub;
  document.title = `${VIEWS[view].title} | 광고 성과 통합 대시보드`;
  hideTooltip();
  if (focus) { window.scrollTo(0, 0); $('#main').focus({ preventScroll: true }); }
}

window.addEventListener('hashchange', () => showView(location.hash.slice(1), { focus: true }));
showView(location.hash.slice(1));
$('#retry-btn').addEventListener('click', () => load(readForm(), { push: false }));

// 브라우저 뒤로/앞으로 → URL 기준으로 폼 복원 후 재조회
window.addEventListener('popstate', () => {
  const filters = filtersFromURL();
  writeForm(filters);
  load(filters, { push: false });
});

window.addEventListener('scroll', hideTooltip, { passive: true });
// 툴팁은 Esc로 닫을 수 있어야 함 (WCAG 1.4.13)
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') hideTooltip(); });

// 첫 진입: URL 쿼리가 있으면 그 조건으로, 없으면 전체 조회
const initial = filtersFromURL();
writeForm(initial);
load(initial, { push: false });
