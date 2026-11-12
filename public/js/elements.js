/**
 * 화면 요소 · 공통 상수
 * index.html의 요소를 한 번만 찾아 두고 다른 모듈이 가져다 씁니다.
 */

export const $ = (selector) => document.querySelector(selector);

// 사이드바: 조회 조건 · 메뉴

export const form = $('#filter-form');
export const startInput = $('#start');
export const endInput = $('#end');
export const submitBtn = $('#submit-btn');
export const formError = $('#form-error');
export const presetButtons = [...document.querySelectorAll('.preset')];
export const navCampaignCount = $('#nav-campaign-count');

// 상태 안내 · 결과 영역

export const appliedEl = $('#applied');
export const loadingEl = $('#loading');
export const errorBanner = $('#error-banner');
export const errorMessage = $('#error-message');
export const emptyEl = $('#empty');
export const resultsEl = $('#results');

// 성과 요약

export const summaryEl = $('#summary');
export const summarySubEl = $('#summary-sub');
export const donut = $('#donut');
export const donutTotal = $('#donut-total');
export const donutDesc = $('#donut-desc');
export const legendEl = $('#share-legend');
export const tooltip = $('#tooltip');
export const trendEl = $('#trend-chart');
export const trendDesc = $('#trend-desc');
export const trendLegend = $('#trend-legend');
export const trendButtons = [...document.querySelectorAll('.trend-btn')];
export const briefBody = $('#brief-body');
export const briefFoot = $('#brief-foot');
export const briefCsvBtn = $('#brief-csv');

// 캠페인 실적

export const campaignTable = $('#campaign-table');
export const campaignBody = $('#campaign-body');
export const campaignFoot = $('#campaign-foot');
export const campaignCaption = $('#campaign-caption');
export const toolbarInfo = $('#toolbar-info');
export const searchInput = $('#campaign-search');
export const campaignScroll = document.querySelector('.campaign-scroll');
export const campaignCsvBtn = $('#campaign-csv');
export const bandButtons = [...document.querySelectorAll('.band-btn')];

export const PLATFORM_LABELS = { google: 'Google', meta: 'Meta', naver: 'Naver' };
export const FILTER_KEYS = ['start', 'end', 'platform']; // API 쿼리로 보내는 조회 조건
