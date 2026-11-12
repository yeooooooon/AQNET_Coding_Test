/**
 * 일별 성과 추이 그래프 (SVG 직접 그림, 외부 라이브러리 없음)
 * 막대(왼쪽 축) + 선(오른쪽 축)을 겹친 그래프. 버튼으로 두 묶음 중 하나 선택
 *   - ROAS & 광고비 : 광고비 막대(원) + ROAS 선(%)  ← 쓴 만큼 벌었나
 *   - CPA & 전환수  : 전환수 막대(건) + CPA 선(원)  ← 전환의 양과 1건당 비용
 * 단위가 다른 두 값을 구분하도록 오른쪽 축 글자는 선과 같은 색, 범례에 단위 표시
 */
import { tooltip, trendEl, trendDesc, trendLegend } from './elements.js';
import { state } from './state.js';
import { nf, el, svg, svgText, withUnit, positionTooltip, hideTooltip } from './util.js';

export const TREND_MODES = {
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
export function compactNumber(value, unit) {
  if (unit === '%') return `${nf.format(value)}%`;
  if (unit === '원' && value >= 1e8) return `${nf.format(Math.round(value / 1e7) / 10)}억`;
  if (unit === '원' && value >= 1e6) return `${nf.format(Math.round(value / 1e4))}만`;
  return nf.format(value);
}

/** 보기 좋은 눈금 간격 (1·2·2.5·5 × 10의 거듭제곱) */
export function niceStep(raw) {
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
export function axisRange(values, fromZero) {
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
export function barPath(x, y, w, h, r = 4) {
  if (h <= 0) return '';
  const rr = Math.min(r, w / 2, h);
  return `M${x},${y + h}V${y + rr}Q${x},${y} ${x + rr},${y}H${x + w - rr}Q${x + w},${y} ${x + w},${y + rr}V${y + h}Z`;
}

/**
 * 부드러운 곡선 경로 (monotone cubic: Fritsch–Carlson)
 * 점과 점 사이를 곡선으로 잇되, 실제 값보다 위아래로 튀어나가지 않음 → 없는 최고·최저점을 만들지 않음
 */
export function smoothPath(points) {
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
export function renderTrend() {
  const days = state.current.byDate;
  const mode = TREND_MODES[state.trendMode];
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
export function showDayTooltip(d, mode, x, y) {
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
