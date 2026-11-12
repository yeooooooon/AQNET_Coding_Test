/**
 * 데이터 정규화 · 검증 · 중복 제거 · 파일 오류 테스트 (src/dataset.js)
 * 실행: npm test
 *
 * 실제 데이터의 정답 수치를 하드코딩하지 않고, 규칙별로 작은 가짜 데이터를 만들어 검증합니다.
 */
import { test, describe } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  parseCount, parseMicrosToWon, isValidDate, normalizeRow, buildDataset, loadFeeds, DataFileError
} from '../src/dataset.js';

/** 정상 Naver 행 하나 (overrides로 필드를 바꿔 가며 테스트) */
const naver = (overrides = {}) => ({
  stat_date: '2026-11-01', campaign_id: 'C01', campaign_name: '캠페인',
  impressions: 1000, clicks: 10, cost: 5000, conversions: 1, revenue: 20000, ...overrides
});
const google = ({ date = '2026-11-01', id = 'C01', name = '캠페인', ...metrics } = {}) => ({
  segments: { date }, campaign: { id, name },
  metrics: { impressions: 1000, clicks: 10, cost_micros: 5_000_000_000, conversions: 1, conversions_value: 20000, ...metrics }
});

describe('실적 숫자 규칙', () => {
  test('0 이상 정수 number와 숫자만 있는 문자열(앞뒤 공백 허용)을 허용한다', () => {
    assert.equal(parseCount(120), 120);
    assert.equal(parseCount(120.0), 120);
    assert.equal(parseCount(0), 0);
    assert.equal(parseCount('00120'), 120);
    assert.equal(parseCount(' 120 '), 120);
  });

  test('boolean·음수·소수·지수·쉼표·부호·빈 문자열·null은 무효다', () => {
    for (const bad of [true, false, -1, 1.5, '1e3', '1,000', '12x', '+1', '-1', '1.0', '', '  ', null, undefined, NaN, Infinity, {}, [1], 2 ** 53]) {
      assert.equal(typeof parseCount(bad), 'symbol', `${JSON.stringify(bad)}는 무효여야 함`);
    }
  });

  test('Google cost_micros는 1,000,000의 배수만 원으로 변환하고 소수 원이 생기면 무효다', () => {
    assert.equal(parseMicrosToWon(5_000_000_000), 5000);
    assert.equal(parseMicrosToWon('2000000'), 2);
    assert.equal(parseMicrosToWon(0), 0);
    assert.equal(typeof parseMicrosToWon(1_500_000), 'symbol');
    assert.equal(typeof parseMicrosToWon(999), 'symbol');
  });
});

describe('날짜 · ID · 캠페인명', () => {
  test('정확한 YYYY-MM-DD, 2000~2099년 실제 날짜만 유효하다', () => {
    for (const ok of ['2026-11-01', '2000-01-01', '2099-12-31', '2028-02-29']) assert.ok(isValidDate(ok), ok);
    for (const bad of ['2026-02-30', '2027-02-29', '1999-12-31', '2100-01-01', '2026-1-01', ' 2026-11-01', '2026-11-01T00:00:00', '20261101', 20261101, null]) {
      assert.ok(!isValidDate(bad), String(bad));
    }
  });

  test('숫자 타입 ID·빈 ID는 행 무효, 문자열 ID는 trim하고 대소문자를 유지한다', () => {
    assert.equal(normalizeRow('naver', naver({ campaign_id: 101 })), null);
    assert.equal(normalizeRow('naver', naver({ campaign_id: '   ' })), null);
    assert.equal(normalizeRow('naver', naver({ campaign_id: '  c01 ' })).campaignId, 'c01');
  });

  test('캠페인명이 누락·null·비문자열·공백뿐이면 campaignId로 대체하고, 정상 이름은 trim한다', () => {
    for (const name of [undefined, null, 123, '   ']) {
      assert.equal(normalizeRow('naver', naver({ campaign_id: ' C07 ', campaign_name: name })).campaignName, 'C07');
    }
    assert.equal(normalizeRow('naver', naver({ campaign_name: '  브랜드 검색  ' })).campaignName, '브랜드 검색');
  });

  test('필수 필드가 누락되거나 중첩 구조가 깨지면 행 무효 (0으로 보정하지 않음)', () => {
    const { cost, ...withoutCost } = naver();
    assert.equal(normalizeRow('naver', withoutCost), null);
    assert.equal(normalizeRow('google', { segments: { date: '2026-11-01' }, campaign: { id: 'C1' }, metrics: null }), null);
    assert.equal(normalizeRow('naver', null), null);
    assert.equal(normalizeRow('naver', [1, 2]), null);
  });

  test('매체별 필드명이 공통 구조로 매핑된다 (Meta 문자열 숫자, Google micros 포함)', () => {
    const meta = normalizeRow('meta', {
      date_start: '2026-11-02', campaign_id: 'M1', campaign_name: '메타',
      impressions: '100', inline_link_clicks: '7', spend: '3000', purchases: '2', purchase_value: '9000'
    });
    assert.deepEqual(meta, {
      date: '2026-11-02', platform: 'meta', campaignId: 'M1', campaignName: '메타',
      impressions: 100, clicks: 7, cost: 3000, conversions: 2, revenue: 9000
    });
    assert.equal(normalizeRow('google', google()).cost, 5000);
  });
});

describe('무효 제거 → 중복 제거 · quality 수치', () => {
  test('앞의 무효 행은 뒤의 유효 행을 막지 않고, 첫 유효 행 이후의 같은 키는 값이 달라도 중복이다', () => {
    const { rows, quality } = buildDataset({
      naver: [
        naver({ cost: null }),           // 무효 (같은 키지만 중복 판정에 참여하지 않음)
        naver({ cost: 1000 }),           // 유지 ← 첫 유효 행
        naver({ cost: 9999 }),           // 중복 (값이 달라도 제외)
        naver({ cost: '12x' }),          // 무효 (중복보다 무효가 먼저)
        naver({ stat_date: '2026-11-02' }) // 다른 날짜 → 별개 행
      ],
      meta: [],
      google: [google()]                 // 같은 ID·날짜라도 매체가 다르면 별개 행
    });
    assert.deepEqual(quality, { inputRows: 6, invalidRows: 2, duplicateRows: 1, validRows: 3 });
    assert.equal(rows.find((r) => r.platform === 'naver' && r.date === '2026-11-01').cost, 1000);
    assert.equal(quality.inputRows, quality.invalidRows + quality.duplicateRows + quality.validRows);
  });

  test('오류가 여러 개인 행도 invalidRows에 한 번만 센다', () => {
    const { quality } = buildDataset({ naver: [naver({ stat_date: 'x', campaign_id: 1, cost: -1, clicks: '1.0' })] });
    assert.equal(quality.invalidRows, 1);
  });

  test('ID는 대소문자를 구별하므로 C01과 c01은 중복이 아니다', () => {
    const { quality } = buildDataset({ naver: [naver({ campaign_id: 'C01' }), naver({ campaign_id: 'c01' }), naver({ campaign_id: ' C01 ' })] });
    assert.deepEqual(quality, { inputRows: 3, invalidRows: 0, duplicateRows: 1, validRows: 2 }); // ' C01 '은 trim 후 C01과 중복
  });
});

describe('파일 오류는 0건으로 숨기지 않는다', () => {
  const makeDir = (files) => {
    const dir = mkdtempSync(path.join(tmpdir(), 'aqnet-'));
    for (const [name, text] of Object.entries(files)) writeFileSync(path.join(dir, name), text);
    return dir;
  };
  const cases = {
    '파일 누락': { 'naver.json': '[]', 'meta.json': '[]' },
    'JSON 파싱 실패': { 'naver.json': '[]', 'meta.json': '[{', 'google.json': '[]' },
    '최상위가 배열 아님': { 'naver.json': '{"rows":[]}', 'meta.json': '[]', 'google.json': '[]' }
  };
  for (const [name, files] of Object.entries(cases)) {
    test(`${name} → DataFileError`, () => {
      const dir = makeDir(files);
      try {
        assert.throws(() => loadFeeds(dir), DataFileError);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  }

  test('정상 파일(BOM 포함)은 읽힌다', () => {
    const dir = makeDir({ 'naver.json': '﻿[]', 'meta.json': '[]', 'google.json': '[1]' });
    try {
      assert.deepEqual(loadFeeds(dir), { google: [1], meta: [], naver: [] });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
