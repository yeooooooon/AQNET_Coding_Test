import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';

// 스타터 프로젝트가 읽히는지 확인하는 예시입니다.
// 실제 채점을 위해 구현 코드에 대한 테스트를 최소 2개 이상 추가하세요.
test('가상 데이터 3종이 JSON 배열로 제공된다', () => {
  for (const platform of ['naver', 'meta', 'google']) {
    const rows = JSON.parse(readFileSync(new URL(`../data/${platform}.json`, import.meta.url)));
    assert.ok(Array.isArray(rows));
    assert.ok(rows.length > 0);
  }
});
