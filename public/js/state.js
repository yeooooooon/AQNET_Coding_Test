/**
 * 화면 상태
 * 여러 모듈이 함께 읽고 바꾸는 값을 state 객체 하나에 모았습니다.
 * 화면에 보이는 숫자는 모두 state.current(마지막으로 성공한 조회 결과)에서 그립니다.
 */

/**
 * current = 마지막으로 성공한 조회 결과
 *   filters        : 그 결과를 만든 조회 조건 (적용 조건 표시·CSV 파일명)
 *   totals · byPlatform · byDate : /api/summary 응답
 *   campaigns      : /api/campaigns 응답 (검색·정렬·필터는 이 목록 안에서만)
 *   campaignError  : 캠페인 API만 실패했을 때의 오류 (성과 요약은 정상 표시)
 *   shownCampaigns · shownTotal : 지금 캠페인 표에 보이는 목록·합계 (CSV가 그대로 사용)
 */
export const EMPTY_STATE = { filters: null, totals: null, byPlatform: [], byDate: [], campaigns: [], campaignError: null, shownCampaigns: [], shownTotal: null };

export const state = {
  controller: null,                     // 진행 중인 요청 (새 조회 시 취소)
  hasResult: false,                     // 현재 화면에 유효한 결과가 표시되어 있는지
  current: { ...EMPTY_STATE },          // 마지막으로 성공한 조회 결과
  dataRange: { start: null, end: null }, // 전체 데이터 기간 (API dataRange) → 빠른 기간 선택 기준
  sortState: { key: 'cost', dir: 'desc' }, // 캠페인 표 정렬 (기본: 광고비 내림차순 = API 순서)
  trendMode: 'roas-cost',               // 일별 추이 그래프 묶음
  roasBand: 'all'                       // 캠페인 ROAS 기준 필터
};
