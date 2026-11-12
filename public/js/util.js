/**
 * 공통 도우미
 * 요소 만들기 · 숫자 표시 · 날짜 계산 · 툴팁 위치
 */
import { tooltip, PLATFORM_LABELS } from './elements.js';

export const nf = new Intl.NumberFormat('ko-KR', { maximumFractionDigits: 2 }); // 1,234.56 (0은 "0")

/**
 * 화면 요소 만들기: el('td', { class: 'num', text: '1,000' }, 자식…)
 * text는 textContent로 넣으므로 HTML로 해석되지 않음 (XSS 방지)
 */
export function el(tag, props = {}, ...children) {
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
export function svg(tag, attrs = {}) {
  const node = document.createElementNS('http://www.w3.org/2000/svg', tag);
  for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, value);
  return node;
}

/** SVG 글자 요소 (그래프 축 글자) */
export function svgText(text, attrs) {
  const node = svg('text', attrs);
  node.textContent = text;
  return node;
}

/** null(분모 0) → "—" + 스크린리더용 "계산 불가". 0은 그대로 "0" */
export function valueNodes(value, reason = '계산 불가') {
  if (value === null || value === undefined) {
    return [el('span', { class: 'na', 'aria-hidden': 'true', title: reason, text: '—' }), el('span', { class: 'sr-only', text: reason })];
  }
  return [nf.format(value)];
}

/** "120원", "3.5%" 처럼 단위를 붙인 글자. null이면 "—" */
export const withUnit = (value, unit) => (value === null ? '—' : `${nf.format(value)}${unit}`);

export const platformName = (p) => PLATFORM_LABELS[p] ?? p;

/** 매체 표시: 색 점 + 매체명 (색만으로 구분하지 않도록 이름을 항상 함께) */
export function platformBadge(platform) {
  return el('span', { class: 'badge', 'data-platform': platform },
    el('span', { class: 'dot', 'aria-hidden': 'true' }), platformName(platform));
}

/** 적용 조건 문장: "2026.11.01 ~ 2026.11.03 · Meta" */
export function describeFilters(f) {
  const dot = (d) => d.replaceAll('-', '.');
  const period = f.start || f.end ? `${f.start ? dot(f.start) : '처음'} ~ ${f.end ? dot(f.end) : '끝'}` : '전체 기간';
  return `${period} · ${f.platform ? platformName(f.platform) : '전체 매체'}`;
}

/** 'YYYY-MM-DD'에서 n일 이동 (UTC 기준 → 시간대 영향 없음) */
export function addDays(date, n) {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/** 툴팁을 마우스 옆에 두되 화면 밖으로 나가지 않게 */
export function positionTooltip(x, y) {
  const pad = 14;
  const { width, height } = tooltip.getBoundingClientRect();
  tooltip.style.left = `${Math.max(8, Math.min(x + pad, window.innerWidth - width - 8))}px`;
  tooltip.style.top = `${Math.max(8, y + pad + height > window.innerHeight ? y - height - pad : y + pad)}px`;
}

export function hideTooltip() {
  tooltip.hidden = true;
}
