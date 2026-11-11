// TODO: 제공된 서로 다른 광고 매체 데이터를 공통 구조로 정규화하고 집계하세요.
// 정확한 반환 형식은 README.md의 '필수 API 응답 형식'을 따릅니다.
// 외부 라이브러리 설치는 필수가 아닙니다.

export class InvalidQueryError extends Error {
  constructor(message) { super(message); this.name = 'InvalidQueryError'; }
}

export function getSummary(feeds, searchParams) {
  // TODO: GET /api/summary - 날짜/매체 필터 + 매체별·전체 합계 및 파생 지표
  throw new Error('NOT_IMPLEMENTED');
}

export function getCampaigns(feeds, searchParams) {
  // TODO: GET /api/campaigns - 캠페인별 집계 + 정렬
  throw new Error('NOT_IMPLEMENTED');
}
