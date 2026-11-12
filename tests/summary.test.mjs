/**
 * src/summary.js · server.js 테스트
 *   지표 계산(반올림·0 분모·합계 기준) · 필터·응답 구조(byPlatform 순서, 빈 결과, dataRange·byDate)
 *   캠페인 집계 · 쿼리 검증(400) · HTTP 응답 · 제공 데이터 일관성 · 서버 시작 실패
 * 실행: npm test
 */
import { test, describe, before, after } from 'node:test';
import { strict as assert } from 'node:assert';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildDataset } from '../src/dataset.js';
import { getSummary, getCampaigns, parseQuery, ratio, InvalidQueryError } from '../src/summary.js';
import { createServer, loadDataset } from '../server.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const q = (s) => new URLSearchParams(s);
const naver = (date, id, [impressions, clicks, cost, conversions, revenue]) =>
  ({ stat_date: date, campaign_id: id, campaign_name: id, impressions, clicks, cost, conversions, revenue });
const meta = (date, id, [impressions, clicks, cost, conversions, revenue]) =>
  ({ date_start: date, campaign_id: id, impressions: String(impressions), inline_link_clicks: String(clicks), spend: String(cost), purchases: String(conversions), purchase_value: String(revenue) });

// 손으로 계산할 수 있는 작은 데이터
const dataset = buildDataset({
  naver: [
    naver('2026-11-01', 'N1', [1000, 30, 6000, 3, 30000]),
    naver('2026-11-02', 'N1', [1000, 10, 2000, 1, 0]),
    naver('2026-11-02', 'N1', [9999, 999, 999, 999, 999]), // 중복 → 제외
    naver('2026-11-03', 'N2', [500, 0, 0, 0, 0]),
    naver('bad', 'N3', [1, 1, 1, 1, 1])                    // 무효 → 제외
  ],
  meta: [meta('2026-11-01', 'N1', [0, 0, 0, 0, 7000])],    // 광고비 0원 + 매출 있음
  google: []
});

describe('지표 계산', () => {
  test('소수 둘째 자리 사사오입: 1.005 → 1.01 (부동소수점 오차 없음)', () => {
    assert.equal(ratio(201, 200), 1.01);   // 201/200 = 1.005
    assert.equal(ratio(1, 3, 100), 33.33);
    assert.equal(ratio(2, 3, 100), 66.67);
    assert.equal(ratio(1, 8), 0.13);       // 0.125 → 0.13
    assert.equal(ratio(0, 5), 0);
  });

  test('분모가 0이면 null (0과 구분)', () => {
    assert.equal(ratio(5, 0), null);
    assert.equal(ratio(0, 0), null);
  });

  test('합계끼리 나눠 계산한다 (행별 비율의 평균이 아님)', () => {
    const { totals } = getSummary(dataset, q('platform=naver&end=2026-11-02'));
    // 합계: 노출 2000, 클릭 40, 광고비 8000, 전환 4, 매출 30000
    assert.deepEqual(totals, {
      impressions: 2000, clicks: 40, cost: 8000, conversions: 4, revenue: 30000,
      ctr: 2, cpc: 200, cpa: 2000, roas: 375
    });
    // 행별 ROAS 평균이었다면 (500 + 0) / 2 = 250
  });

  test('광고비 0원·매출 있음 → ROAS·CPC·CPA null, 기본 합계는 실제 0', () => {
    const { byPlatform } = getSummary(dataset, q('platform=meta'));
    assert.deepEqual(byPlatform, [{
      platform: 'meta', impressions: 0, clicks: 0, cost: 0, conversions: 0, revenue: 7000,
      ctr: null, cpc: null, cpa: null, roas: null
    }]);
  });
});

describe('필터 · 응답 구조', () => {
  test('byPlatform은 유효 행이 있는 매체만 google → meta → naver 순서, 0원 매체도 포함', () => {
    const { byPlatform, totals, quality } = getSummary(dataset, q(''));
    assert.deepEqual(byPlatform.map((p) => p.platform), ['meta', 'naver']);
    assert.equal(totals.revenue, 37000);
    assert.deepEqual(quality, { inputRows: 6, invalidRows: 1, duplicateRows: 1, validRows: 4, matchedRows: 4 });
  });

  test('기간은 양 끝 포함이며 한쪽만 입력할 수 있다', () => {
    assert.equal(getSummary(dataset, q('start=2026-11-02&end=2026-11-02')).quality.matchedRows, 1);
    assert.equal(getSummary(dataset, q('start=2026-11-02')).quality.matchedRows, 2);
    assert.equal(getSummary(dataset, q('end=2026-11-01')).quality.matchedRows, 2);
  });

  test('byDate는 현재 필터의 날짜별 합계이며 날짜 오름차순, 합하면 totals와 같다', () => {
    const all = getSummary(dataset, q(''));
    assert.deepEqual(all.byDate.map((d) => d.date), ['2026-11-01', '2026-11-02', '2026-11-03']);
    for (const f of ['impressions', 'clicks', 'cost', 'conversions', 'revenue']) {
      assert.equal(all.byDate.reduce((sum, d) => sum + d[f], 0), all.totals[f], f);
    }
    const day1 = all.byDate[0]; // naver N1 + meta(0원, 매출 7000)
    assert.equal(day1.cost, 6000);
    assert.equal(day1.roas, 616.67); // (30000 + 7000) / 6000 × 100
    assert.deepEqual(getSummary(dataset, q('platform=meta')).byDate.map((d) => d.date), ['2026-11-01']);
    assert.deepEqual(getSummary(dataset, q('start=2030-01-01')).byDate, []);
  });

  test('dataRange는 필터와 무관한 전체 유효 행의 기간이다 (무효 행 날짜는 제외)', () => {
    const expected = { start: '2026-11-01', end: '2026-11-03' };
    assert.deepEqual(getSummary(dataset, q('')).dataRange, expected);
    assert.deepEqual(getSummary(dataset, q('platform=meta&start=2030-01-01')).dataRange, expected);
    assert.deepEqual(buildDataset({ naver: [] }).dateRange, { start: null, end: null });
  });

  test('빈 결과: 합계 0, 파생 지표 null, byPlatform [], 전체 quality는 유지', () => {
    const res = getSummary(dataset, q('start=2030-01-01'));
    assert.deepEqual(res.totals, { impressions: 0, clicks: 0, cost: 0, conversions: 0, revenue: 0, ctr: null, cpc: null, cpa: null, roas: null });
    assert.deepEqual(res.byPlatform, []);
    assert.deepEqual(res.quality, { inputRows: 6, invalidRows: 1, duplicateRows: 1, validRows: 4, matchedRows: 0 });
  });
});

describe('캠페인 집계 (/api/campaigns)', () => {
  const ds = buildDataset({
    naver: [
      naver('2026-11-01', 'C1', [100, 10, 1000, 1, 5000]),
      { ...naver('2026-11-02', 'C1', [100, 10, 3000, 1, 0]), campaign_name: null }, // 이름 없음 → 대체
      naver('2026-11-01', 'C2', [100, 10, 4000, 0, 0])
    ],
    meta: [meta('2026-11-01', 'C1', [100, 10, 4000, 2, 8000])], // 같은 ID, 다른 매체
    google: []
  });

  test('(매체, ID)별로 날짜를 합산하고, 광고비 내림차순 → 매체 → ID 순으로 정렬한다', () => {
    const { count, items } = getCampaigns(ds, q(''));
    assert.equal(count, 3);
    assert.deepEqual(items.map((c) => [c.platform, c.campaignId, c.cost]), [
      ['meta', 'C1', 4000], ['naver', 'C1', 4000], ['naver', 'C2', 4000]
    ]);
    const n1 = items.find((c) => c.platform === 'naver' && c.campaignId === 'C1');
    assert.equal(n1.roas, 125);        // 5000 / 4000 × 100 (합계 기준)
    assert.equal(n1.campaignName, 'C1'); // fixture의 실제 이름이 ID와 같음
  });

  test('이름이 비어 ID로 대체된 날보다 실제 이름이 있는 날의 이름을 우선한다', () => {
    const ds2 = buildDataset({ naver: [
      { ...naver('2026-11-01', 'C9', [1, 1, 1, 1, 1]), campaign_name: '진짜 이름' },
      { ...naver('2026-11-02', 'C9', [1, 1, 1, 1, 1]), campaign_name: '  ' }
    ] });
    assert.equal(getCampaigns(ds2, q('')).items[0].campaignName, '진짜 이름');
  });

  test('summary와 같은 필터·쿼리 검증을 사용한다', () => {
    assert.equal(getCampaigns(ds, q('platform=meta')).count, 1);
    assert.deepEqual(getCampaigns(ds, q('start=2030-01-01')), { count: 0, items: [] });
    assert.throws(() => getCampaigns(ds, q('platform=kakao')), InvalidQueryError);
  });
});

describe('쿼리 검증', () => {
  test('빈 문자열은 미입력, 다른 키는 무시', () => {
    assert.deepEqual(parseQuery(q('start=&end=&platform=&foo=bar&page=2')), { start: undefined, end: undefined, platform: undefined });
  });

  const invalid = {
    '공백 문자열 platform': 'platform=%20',
    '공백 문자열 start': 'start=+',
    '앞뒤 공백이 붙은 날짜': 'start=%202026-11-01',
    '반복 키': 'platform=naver&platform=meta',
    '반복 빈 키': 'start=&start=',
    '없는 날짜': 'start=2026-02-30',
    '형식이 틀린 날짜': 'end=2026/11/01',
    '범위 밖 연도': 'end=2100-01-01',
    'start > end': 'start=2026-11-05&end=2026-11-01',
    '알 수 없는 매체': 'platform=kakao',
    '대문자 매체': 'platform=NAVER'
  };
  for (const [name, query] of Object.entries(invalid)) {
    test(`${name} → InvalidQueryError`, () => {
      assert.throws(() => parseQuery(q(query)), InvalidQueryError);
    });
  }
});

describe('HTTP', () => {
  let server;
  let base;
  before(async () => {
    server = createServer(dataset);
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${server.address().port}`;
  });
  after(() => server.close());

  test('200 + application/json', async () => {
    const res = await fetch(`${base}/api/summary?platform=naver`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type'), /application\/json/);
    assert.deepEqual((await res.json()).byPlatform.map((p) => p.platform), ['naver']);
  });

  test('400 + { error: INVALID_QUERY, message }', async () => {
    const res = await fetch(`${base}/api/summary?start=2026-11-05&end=2026-11-01`);
    assert.equal(res.status, 400);
    assert.match(res.headers.get('content-type'), /application\/json/);
    const body = await res.json();
    assert.equal(body.error, 'INVALID_QUERY');
    assert.ok(typeof body.message === 'string' && body.message.trim().length > 0);
  });

  test('대시보드 화면을 같은 서버에서 제공한다', async () => {
    const res = await fetch(`${base}/`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type'), /text\/html/);
  });
});

describe('제공 데이터 (정답 하드코딩 없이 일관성만 검사)', () => {
  const real = loadDataset(path.join(root, 'data'));

  test('quality 항등식과 매체별 합 = 전체 합', () => {
    const { totals, byPlatform, quality } = getSummary(real, q(''));
    assert.equal(quality.inputRows, quality.invalidRows + quality.duplicateRows + quality.validRows);
    assert.equal(quality.matchedRows, quality.validRows);
    for (const f of ['impressions', 'clicks', 'cost', 'conversions', 'revenue']) {
      assert.equal(byPlatform.reduce((sum, p) => sum + p[f], 0), totals[f], f);
      assert.ok(Number.isSafeInteger(totals[f]), `${f}는 정수`);
    }
  });
});

describe('서버 시작', () => {
  test('DATA_DIR의 파일이 잘못되면 0건으로 뜨지 않고 시작에 실패한다', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'aqnet-'));
    writeFileSync(path.join(dir, 'naver.json'), '[]');
    writeFileSync(path.join(dir, 'meta.json'), 'not json');
    writeFileSync(path.join(dir, 'google.json'), '[]');
    try {
      const result = spawnSync(process.execPath, ['server.js'], {
        cwd: root, env: { ...process.env, DATA_DIR: dir, PORT: '0' }, encoding: 'utf8', timeout: 10_000
      });
      assert.equal(result.status, 1);
      assert.match(result.stderr, /JSON 파싱 실패/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
