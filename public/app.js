// TODO: 폼 필터와 /api/summary, /api/campaigns 호출을 연결하세요.
// 요구사항: 광고비/전환/매출/CPA/ROAS 요약, 캠페인 표, 로딩/오류 상태.
// 캠페인명 등 데이터 문자열은 innerHTML 대신 textContent 사용을 권장합니다.

const form = document.querySelector('#filter-form');
const status = document.querySelector('#status');
form.addEventListener('submit', (event) => {
  event.preventDefault();
  status.textContent = 'TODO: API 호출 및 화면 표시를 구현하세요.';
});
