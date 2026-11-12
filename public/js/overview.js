/**
 * 성과 요약 화면
 * 요약 카드 · 보조 지표 · 이전 기간 대비 증감 / 광고비 점유율 도넛 / 매체별 지표 표
 * (일별 추이 그래프는 trend.js)
 */
import { summaryEl, summarySubEl, donut, donutTotal, donutDesc, legendEl, tooltip, briefBody, briefFoot } from './elements.js';
import { nf, el, svg, valueNodes, withUnit, platformName, platformBadge, positionTooltip, hideTooltip } from './util.js';
import { readForm, writeForm, toQuery, load } from './query.js';
import { showView } from './view.js';

// ---------- 요약 카드 · 보조 지표 · 증감

/**
 * 요약: 카드 5개(광고비·전환매출·전환수·CPA·ROAS) + 보조 지표 줄(노출·클릭·CTR·CPC)
 * → 문제지 요약 7개 지표(광고비·전환수·전환매출·CTR·CPC·CPA·ROAS)를 모두 이름과 함께 표시
 * 각 행: [응답 키, 라벨, 단위, 설명, 계산 불가일 때 이유]
 */
export function renderSummary(t, prev) {
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
export const DELTA_RULES = {
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
export function deltaBadge(key, t, prev) {
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

// ---------- 광고비 점유율 도넛

/**
 * 광고비 점유율 도넛 + 범례
 * 원 둘레를 100으로 보고(pathLength=100), 매체별 점유율만큼 선을 이어 그립니다.
 * 범례에 매체명·점유율·금액을 글자로 함께 적어 색만으로 구분하지 않게 함.
 */
export function renderShare(byPlatform, totals) {
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
export function showTooltip(p, share, x, y) {
  const rows = [['점유율', `${nf.format(Math.round(share * 10) / 10)}%`], ['광고비', withUnit(p.cost, '원')],
    ['전환', withUnit(p.conversions, '건')], ['매출', withUnit(p.revenue, '원')], ['CPA', withUnit(p.cpa, '원')], ['ROAS', withUnit(p.roas, '%')]];
  tooltip.replaceChildren(el('strong', {}, platformBadge(p.platform)),
    el('dl', {}, ...rows.flatMap(([label, value]) => [el('dt', { text: label }), el('dd', { text: value })])));
  tooltip.hidden = false;
  positionTooltip(x, y);
}

// ---------- 매체별 지표 표 (행 클릭 → 그 매체의 캠페인 실적으로 이동)

/** 매체별 표의 숫자 열 9개 (index.html thead 순서와 같음). CSV도 같은 순서 */
export const BRIEF_COLUMNS = ['cost', 'impressions', 'clicks', 'conversions', 'revenue', 'ctr', 'cpc', 'cpa', 'roas'];

/** 숫자 칸들: 단위는 열 제목에 있으므로 숫자만. null은 "—"(계산 불가). ROAS 열만 강조 */
export function metricCells(row, columns) {
  return columns.map((key) => el('td', { class: key === 'roas' ? 'num roas' : 'num' }, ...valueNodes(row[key])));
}

/**
 * 매체별 표 + 합계 행 (성과 요약 화면)
 * 칸: 매체 · 광고비 · 노출 · 클릭 · 전환 · 매출 · CTR · CPC · CPA · ROAS (문제지 10개 항목)
 */
export function renderBrief(byPlatform, totals) {
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
export function drillDown(platform) {
  const filters = { ...readForm(), platform };
  writeForm(filters);
  const query = toQuery(filters);
  history.pushState(null, '', `${query ? `?${query}` : location.pathname}#campaigns`);
  showView('campaigns');
  load(filters, { pushHistory: false });
}
