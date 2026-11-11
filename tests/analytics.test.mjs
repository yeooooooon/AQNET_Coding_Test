/**
 * src/analytics.js 자체 테스트 (실행: npm test)
 *
 * 정규화(02) · summary(03·04·06) · campaigns(03·04) · 입력 검증(03) · 반올림(04) · HTTP 응답(03)
 * 실제 데이터로 확인할 수 없는 경우(광고비 동점, 같은 ID·다른 매체)는 가짜 데이터를 만들어 검증합니다.
 */
import { test, describe, before, after } from 'node:test';
import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import {
  getSummary, getCampaigns, normalizeFeeds, round2, InvalidQueryError
} from '../src/analytics.js';

// 제공된 data/*.json을 server.js와 같은 형태로 읽어 둠
const load = (p) => JSON.parse(readFileSync(new URL(`../data/${p}.json`, import.meta.url), 'utf8'));
const feeds = Object.freeze({ naver: load('naver'), meta: load('meta'), google: load('google') });
const q = (s) => new URLSearchParams(s); // 'platform=naver' → 쿼리 파라미터 객체

// 문제지 02: 매체마다 다른 필드를 공통 구조로, 숫자는 모두 number로
describe('정규화', () => {
  test('모든 매체가 공통 구조로 변환되고 실적 필드는 number 타입이다', () => {
    const rows = normalizeFeeds(feeds);
    assert.equal(rows.length, 8);
    const keys = ['date', 'platform', 'campaignId', 'campaignName', 'impressions', 'clicks', 'cost', 'conversions', 'revenue'];
    for (const row of rows) {
      assert.deepEqual(Object.keys(row).sort(), [...keys].sort());
      for (const f of ['impressions', 'clicks', 'cost', 'conversions', 'revenue']) {
        assert.equal(typeof row[f], 'number', `${row.platform} ${f}`);
      }
    }
  });

  test('Meta 문자열 숫자와 Google cost_micros가 올바르게 변환된다', () => {
    const rows = normalizeFeeds(feeds);
    const meta = rows.find((r) => r.campaignId === 'M-201');
    assert.deepEqual(meta, {
      date: '2026-11-01', platform: 'meta', campaignId: 'M-201', campaignName: '신규 고객 전환',
      impressions: 8000, clicks: 170, cost: 40000, conversions: 4, revenue: 200000
    });
    const google = rows.find((r) => r.platform === 'google' && r.date === '2026-11-01');
    assert.equal(google.cost, 40000); // 40,000,000,000 micros / 1,000,000
    assert.equal(google.campaignName, '영상 디스플레이');
  });

  test('숫자로 변환할 수 없는 원본 값은 데이터 오류로 처리한다', () => {
    const bad = { meta: [{ date: '2026-11-01', campaignId: 'M-1', name: 'x', impressions: 'abc', link_clicks: '1', spend: '1', purchases: '0', purchase_value: '0' }] };
    assert.throws(() => normalizeFeeds(bad), /숫자가 아닙니다/);
  });
});

// 문제지 03·04·06: 전체/매체별 합계와 비율 지표
describe('GET /api/summary', () => {
  test('필터 없음: 문제지 06 검증값과 일치한다', () => {
    const { totals, byPlatform } = getSummary(feeds, q(''));
    assert.deepEqual(totals, {
      impressions: 38000, clicks: 980, cost: 420000, conversions: 35, revenue: 1500000,
      ctr: 2.58, cvr: 3.57, cpc: 428.57, cpa: 12000, roas: 357.14
    });
    assert.deepEqual(byPlatform.map((p) => p.platform), ['google', 'meta', 'naver']);
  });

  test('매체별 합계의 합은 전체 합계와 같다', () => {
    const { totals, byPlatform } = getSummary(feeds, q(''));
    for (const f of ['impressions', 'clicks', 'cost', 'conversions', 'revenue']) {
      assert.equal(byPlatform.reduce((s, p) => s + p[f], 0), totals[f], f);
    }
  });

  test('스타터 README 예시: naver 2026-11-02 하루 광고비는 90000', () => {
    const { totals, byPlatform } = getSummary(feeds, q('start=2026-11-02&end=2026-11-02&platform=naver'));
    assert.equal(totals.cost, 90000);
    assert.equal(byPlatform.length, 1);
    assert.equal(byPlatform[0].platform, 'naver');
  });

  test('날짜 경계는 양쪽 모두 포함한다 (start만 / end만 지정)', () => {
    assert.equal(getSummary(feeds, q('start=2026-11-02')).totals.cost, 90000 + 50000 + 50000);
    assert.equal(getSummary(feeds, q('end=2026-11-01')).totals.cost, 120000 + 30000 + 0 + 40000 + 40000);
  });

  test('빈 결과: 합계 0, 파생 지표 null, byPlatform 빈 배열', () => {
    const { totals, byPlatform } = getSummary(feeds, q('start=2026-12-01'));
    assert.deepEqual(totals, {
      impressions: 0, clicks: 0, cost: 0, conversions: 0, revenue: 0,
      ctr: null, cvr: null, cpc: null, cpa: null, roas: null
    });
    assert.deepEqual(byPlatform, []);
  });

  test('비율은 행별 비율의 평균이 아니라 합계로 계산한다', () => {
    // naver 행별 CTR: 3.33%, 3.67%, 2.5%, 0%  → 평균 내면 2.38% (틀린 방법)
    // 합계로 계산: 클릭 470 / 노출 15,000 × 100 = 3.13% (문제지 04 방식)
    const naver = getSummary(feeds, q('platform=naver')).totals;
    assert.equal(naver.ctr, 3.13);
    assert.equal(naver.cpa, 12000); // 240000 / 20
  });

  test('빈 문자열 파라미터는 미입력으로 처리한다 (폼의 "전체" 선택)', () => {
    assert.equal(getSummary(feeds, q('start=&end=&platform=')).totals.cost, 420000);
  });
});

// 문제지 03·04: 캠페인별 합산(platform + campaignId) 및 정렬
describe('GET /api/campaigns', () => {
  test('platform+campaignId 기준으로 합산되고 광고비 내림차순으로 정렬된다', () => {
    const { count, items } = getCampaigns(feeds, q(''));
    assert.equal(count, 6);
    assert.deepEqual(items.map((i) => `${i.platform}:${i.campaignId}:${i.cost}`), [
      'naver:N-101:210000', 'google:G-301:90000', 'meta:M-202:50000',
      'meta:M-201:40000', 'naver:N-102:30000', 'naver:N-999:0'
    ]);
    const n101 = items[0];
    assert.equal(n101.campaignName, '브랜드 검색 A');
    assert.equal(n101.cpa, 11666.67);
  });

  test('광고비 동점이면 platform → campaignId 사전순으로 정렬한다', () => {
    // 실제 데이터엔 광고비가 같은 캠페인이 없어서, 광고비 100원짜리 3개를 직접 만들어 확인
    const row = (id) => ({ date: '2026-11-01', campaign_id: id, campaign_name: id, impressions: 1, clicks: 1, cost: 100, conversions: 0, revenue: 0 });
    const tie = {
      naver: [row('N-2'), row('N-1')],
      meta: [{ date: '2026-11-01', campaignId: 'M-9', name: 'm', impressions: '1', link_clicks: '1', spend: '100', purchases: '0', purchase_value: '0' }],
      google: []
    };
    const { items } = getCampaigns(tie, q(''));
    assert.deepEqual(items.map((i) => i.campaignId), ['M-9', 'N-1', 'N-2']);
  });

  test('같은 campaignId라도 매체가 다르면 다른 캠페인이다', () => {
    const dup = {
      naver: [{ date: '2026-11-01', campaign_id: 'X', campaign_name: 'n', impressions: 1, clicks: 1, cost: 10, conversions: 1, revenue: 1 }],
      meta: [{ date: '2026-11-01', campaignId: 'X', name: 'm', impressions: '1', link_clicks: '1', spend: '20', purchases: '1', purchase_value: '1' }]
    };
    assert.equal(getCampaigns(dup, q('')).count, 2);
  });

  test('분모가 0인 파생 지표는 null (N-999 무료 노출 테스트)', () => {
    const n999 = getCampaigns(feeds, q('')).items.find((i) => i.campaignId === 'N-999');
    assert.equal(n999.ctr, 0); // 0 / 1000 → 분모가 0이 아니므로 0
    assert.equal(n999.cvr, null);
    assert.equal(n999.cpc, null);
    assert.equal(n999.cpa, null);
    assert.equal(n999.roas, null);
  });

  test('빈 결과: count 0, items 빈 배열', () => {
    assert.deepEqual(getCampaigns(feeds, q('end=2026-10-31')), { count: 0, items: [] });
  });
});

// 문제지 03: 잘못된 날짜·매체·start > end → 400 (InvalidQueryError)
// 같은 검사를 여러 입력값으로 반복하기 위해 목록 + 반복문으로 작성
describe('입력 검증', () => {
  const invalid = [
    ['형식 오류 날짜', 'start=2026/11/01'],
    ['존재하지 않는 날짜', 'end=2026-02-30'],
    ['한 자리 월', 'start=2026-1-01'],
    ['start > end', 'start=2026-11-02&end=2026-11-01'],
    ['허용되지 않은 매체', 'platform=kakao'],
    ['대소문자 다른 매체', 'platform=Naver'],
    ['중복 파라미터', 'platform=naver&platform=meta']
  ];
  for (const [name, query] of invalid) {
    test(`${name} → InvalidQueryError (${query})`, () => {
      assert.throws(() => getSummary(feeds, q(query)), InvalidQueryError);
      assert.throws(() => getCampaigns(feeds, q(query)), InvalidQueryError);
    });
  }

  test('start == end 는 허용된다', () => {
    assert.doesNotThrow(() => getSummary(feeds, q('start=2026-11-01&end=2026-11-01')));
  });
});

// 문제지 04: 소수 둘째 자리 반올림
describe('round2', () => {
  test('소수 둘째 자리 반올림 (부동소수 오차 보정)', () => {
    // Math.round(1.005 * 100) / 100 은 1이 나오는 문제를 피했는지 확인
    assert.equal(round2(1.005), 1.01);
    assert.equal(round2(428.5714), 428.57);
    assert.equal(round2(2.578947), 2.58);
    assert.equal(round2(12000), 12000);
  });
});

// 실제 서버를 띄워서 HTTP 상태 코드와 응답 형식까지 확인
describe('HTTP 서버', () => {
  let server;
  let base;
  // 포트 0 = 비어 있는 아무 포트 (npm start로 3000번이 이미 쓰여도 충돌하지 않음)
  before(async () => {
    ({ server } = await import('../server.js'));
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${server.address().port}`;
  });
  after(() => new Promise((resolve) => server.close(resolve)));

  test('정상 요청은 200과 JSON을 반환한다', async () => {
    const res = await fetch(`${base}/api/summary`);
    assert.equal(res.status, 200);
    assert.equal((await res.json()).totals.cost, 420000);
  });

  test('잘못된 쿼리는 400 + INVALID_QUERY 를 반환한다', async () => {
    for (const path of ['/api/summary?platform=kakao', '/api/campaigns?start=2026-11-03&end=2026-11-01']) {
      const res = await fetch(base + path);
      assert.equal(res.status, 400, path);
      const body = await res.json();
      assert.equal(body.error, 'INVALID_QUERY');
      assert.equal(typeof body.message, 'string');
    }
  });
});
