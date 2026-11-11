// 필터 폼 → /api/summary, /api/campaigns 호출 → 요약 카드/캠페인 표 렌더링.
// 데이터 문자열은 모두 textContent로 넣어 XSS를 방지합니다 (innerHTML 미사용).

const form = document.querySelector('#filter-form');
const startInput = document.querySelector('#start');
const endInput = document.querySelector('#end');
const platformSelect = document.querySelector('#platform');
const submitButton = form.querySelector('button[type="submit"]');
const status = document.querySelector('#status');
const summaryEl = document.querySelector('#summary');
const campaignBody = document.querySelector('#campaign-body');

const PLATFORM_LABELS = { naver: 'Naver', meta: 'Meta', google: 'Google' };
const numberFmt = new Intl.NumberFormat('ko-KR', { maximumFractionDigits: 2 });

const fmt = {
  won: (v) => (v == null ? '-' : `${numberFmt.format(v)}원`),
  count: (v) => (v == null ? '-' : `${numberFmt.format(v)}건`),
  percent: (v) => (v == null ? '-' : `${numberFmt.format(v)}%`)
};

let currentController = null;

function el(tag, text, className) {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  if (className) node.className = className;
  return node;
}

function setStatus(message, kind = 'info') {
  status.textContent = message;
  status.dataset.kind = kind; // styles.css에서 info/loading/error 색상 구분
}

function buildQuery() {
  const params = new URLSearchParams();
  if (startInput.value) params.set('start', startInput.value);
  if (endInput.value) params.set('end', endInput.value);
  if (platformSelect.value) params.set('platform', platformSelect.value);
  return params.toString();
}

async function fetchJson(path, signal) {
  const res = await fetch(path, { signal, headers: { accept: 'application/json' } });
  let body = null;
  try { body = await res.json(); } catch { /* JSON이 아닌 응답 */ }
  if (!res.ok) {
    const message = body?.message || body?.error || `요청 실패 (HTTP ${res.status})`;
    throw new Error(message);
  }
  return body;
}

function renderSummary(totals) {
  const cards = [
    ['광고비', fmt.won(totals.cost)],
    ['전환수', fmt.count(totals.conversions)],
    ['매출', fmt.won(totals.revenue)],
    ['CPA', fmt.won(totals.cpa)],
    ['ROAS', fmt.percent(totals.roas)]
  ];
  summaryEl.replaceChildren(...cards.map(([label, value]) => {
    const card = el('div');
    card.append(el('small', label), el('strong', value));
    return card;
  }));
}

function renderCampaigns(items) {
  if (items.length === 0) {
    const td = el('td', '조회 조건에 해당하는 캠페인이 없습니다.', 'empty');
    td.colSpan = 5;
    const tr = el('tr');
    tr.append(td);
    campaignBody.replaceChildren(tr);
    return;
  }
  campaignBody.replaceChildren(...items.map((item) => {
    const tr = el('tr');
    tr.append(
      el('td', PLATFORM_LABELS[item.platform] ?? item.platform),
      el('td', item.campaignName),
      el('td', fmt.won(item.cost), 'num'),
      el('td', fmt.count(item.conversions), 'num'),
      el('td', fmt.percent(item.roas), 'num')
    );
    return tr;
  }));
}

async function load() {
  // 클라이언트 1차 검증 (서버도 동일하게 검증하므로 보조 수단)
  if (startInput.value && endInput.value && startInput.value > endInput.value) {
    setStatus('시작일은 종료일보다 늦을 수 없습니다.', 'error');
    return;
  }

  // 이전 요청이 진행 중이면 취소해 늦게 도착한 응답이 화면을 덮어쓰지 않게 합니다.
  currentController?.abort();
  const controller = new AbortController();
  currentController = controller;

  const query = buildQuery();
  const suffix = query ? `?${query}` : '';
  setStatus('불러오는 중…', 'loading');
  submitButton.disabled = true;
  form.setAttribute('aria-busy', 'true');

  try {
    const [summary, campaigns] = await Promise.all([
      fetchJson(`/api/summary${suffix}`, controller.signal),
      fetchJson(`/api/campaigns${suffix}`, controller.signal)
    ]);
    renderSummary(summary.totals);
    renderCampaigns(campaigns.items);
    setStatus(`조회 완료 · 캠페인 ${campaigns.count}개`, 'info');
  } catch (error) {
    if (error.name === 'AbortError') return;
    setStatus(`오류: ${error.message}`, 'error');
  } finally {
    if (currentController === controller) {
      currentController = null;
      submitButton.disabled = false;
      form.removeAttribute('aria-busy');
    }
  }
}

form.addEventListener('submit', (event) => {
  event.preventDefault();
  load();
});

// 첫 진입 시 전체 기간·전체 매체로 조회
load();
