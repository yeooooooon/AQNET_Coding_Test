/**
 * 조회
 * 조회 조건 ↔ 입력칸 · 주소(?start=…&platform=…)
 * load(): 조건 검증 → 주소 반영 → 이전 요청 취소 → API 3개 동시 호출 → 결과/오류 화면
 * 빠른 기간 선택(7일 · 14일 · 전체): API가 알려 준 데이터 기간의 마지막 날짜 기준 → 날짜 하드코딩 없음
 */
import { form, startInput, endInput, formError, presetButtons, PLATFORM_LABELS, FILTER_KEYS } from './elements.js';
import { state } from './state.js';
import { addDays } from './util.js';
import { showLoading, showError, showResult } from './view.js';

// ---------- 조회 조건 ↔ 입력칸 · 주소

export function readForm() {
  return { start: startInput.value, end: endInput.value, platform: form.elements.platform.value };
}

export function writeForm(f) {
  startInput.value = f.start || '';
  endInput.value = f.end || '';
  // 라디오 묶음에 value를 한 번에 넣으면 "전체"(value="") 선택 표시가 바뀌지 않는 경우가 있어 버튼마다 직접 지정
  const platform = PLATFORM_LABELS[f.platform] ? f.platform : '';
  for (const radio of form.querySelectorAll('input[name="platform"]')) radio.checked = radio.value === platform;
}

export function filtersFromURL() {
  const params = new URLSearchParams(location.search);
  return Object.fromEntries(FILTER_KEYS.map((key) => [key, params.get(key) || '']));
}

/** 빈 값은 빼고 쿼리 문자열로 → "start=2026-11-01&platform=meta" */
export function toQuery(f) {
  const params = new URLSearchParams();
  for (const key of FILTER_KEYS) if (f[key]) params.set(key, f[key]);
  return params.toString();
}

/** 브라우저 단에서 막을 수 있는 오류만 미리 안내 (서버도 같은 검사를 하고 400을 돌려줌) */
export function validate(f) {
  const invalid = Boolean(f.start && f.end && f.start > f.end);
  startInput.setAttribute('aria-invalid', String(invalid));
  endInput.setAttribute('aria-invalid', String(invalid));
  formError.hidden = !invalid;
  formError.textContent = invalid ? '시작일은 종료일보다 늦을 수 없습니다.' : '';
  return !invalid;
}

// ---------- API 조회

/** GET + JSON 변환. 실패(400/500 등)면 서버가 보낸 message로 에러를 던짐 */
export async function fetchJson(path, query, signal) {
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
export function previousPeriod(f) {
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
export async function load(filters, { pushHistory = true } = {}) {
  if (!validate(filters)) return;
  const query = toQuery(filters);
  const search = query ? `?${query}` : '';
  if (pushHistory && search !== location.search) history.pushState(null, '', `${search || location.pathname}${location.hash}`);

  // 이전 요청 취소 → 늦게 도착한 옛 응답이 최신 결과를 덮어쓰지 않도록
  state.controller?.abort();
  const ctrl = new AbortController();
  state.controller = ctrl;
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
    if (state.controller === ctrl) {
      state.controller = null;
      showLoading(false);
    }
  }
}

// ---------- 빠른 기간 선택

/** 빠른 기간 → { start, end }. days=0은 전체(미입력). 최근 N일 = 데이터 마지막 날짜 포함 N일 (데이터 시작일보다 앞으로는 가지 않음) */
export function presetRange(days) {
  if (!days || !state.dataRange.end) return { start: '', end: '' };
  const start = addDays(state.dataRange.end, -(days - 1));
  return { start: start < state.dataRange.start ? state.dataRange.start : start, end: state.dataRange.end };
}

/** API가 알려준 데이터 기간으로 달력 선택 범위 제한 + 빠른 기간 버튼 활성화 */
export function applyDataRange(range) {
  state.dataRange = range?.start ? range : { start: null, end: null };
  for (const input of [startInput, endInput]) {
    input.min = state.dataRange.start ?? '2000-01-01';
    input.max = state.dataRange.end ?? '2099-12-31';
  }
  for (const btn of presetButtons) btn.disabled = !state.dataRange.end;
}

/** 지금 적용된 조건과 같은 빠른 기간 버튼을 눌린 상태로 표시 (날짜를 직접 고르면 해제) */
export function markPreset(filters) {
  // 빠른 기간(7일·14일·전체) → 날짜 칸을 채우고 조회
for (const btn of presetButtons) {
    const days = Number(btn.dataset.days);
    const r = presetRange(days);
    // 전체(0) = 기간 미입력이면 항상 눌림. 7일·14일은 데이터 기간을 알아야 계산 가능
    const on = Boolean(filters && (days === 0 || state.dataRange.end) && (filters.start || '') === r.start && (filters.end || '') === r.end);
    btn.setAttribute('aria-pressed', String(on));
  }
}
