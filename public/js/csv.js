/**
 * CSV 내보내기 (현재 조회·검색·정렬 결과 그대로)

 */
import { state } from './state.js';
import { el } from './util.js';
import { BRIEF_COLUMNS } from './overview.js';

/**
 * CSV 파일 내려받기 (엑셀에서 한글이 깨지지 않도록 UTF-8 BOM 포함)
 * - 숫자는 천 단위 쉼표 없이 원값, null(계산 불가)은 빈 칸
 * - 글자 값이 = + - @ 로 시작하면 앞에 ' 를 붙여 엑셀이 수식으로 실행하지 않게 함 (CSV 수식 주입 방지)
 */
export function downloadCsv(filename, header, rows) {
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
export function csvName(prefix) {
  const f = state.current.filters ?? {};
  return `${prefix}_${f.start || 'all'}_${f.end || 'all'}_${f.platform || 'all-platforms'}.csv`;
}

export const METRIC_HEADERS = ['광고비(원)', '노출(회)', '클릭(회)', '전환(건)', '매출(원)', 'CTR(%)', 'CPC(원)', 'CPA(원)', 'ROAS(%)'];
export const metricValues = (row) => BRIEF_COLUMNS.map((key) => row[key]);
