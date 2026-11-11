/**
 * HTTP 서버 (스타터코드 기반)
 * - GET /health          : 서버 상태 확인
 * - GET /api/summary     : 전체·매체별 지표   → src/analytics.js getSummary()
 * - GET /api/campaigns   : 캠페인별 지표       → src/analytics.js getCampaigns()
 * - GET / , /app.js ...  : public/ 폴더의 화면 파일
 *
 * 지원자 수정 사항: server를 export하고, 직접 실행할 때만 listen 하도록 변경 (맨 아래)
 *   → 테스트에서 서버를 임의 포트로 띄워 실제 HTTP 응답(200/400)까지 검증하기 위함
 */
import http from 'node:http';
import { readFile, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getSummary, getCampaigns, InvalidQueryError } from './src/analytics.js';

const root = path.dirname(fileURLToPath(import.meta.url));

// 광고 데이터는 서버 시작 시 한 번만 읽고, 이후 바뀌지 않도록 고정(freeze)합니다.
const feeds = Object.freeze({
  naver: JSON.parse(readFileSync(path.join(root, 'data/naver.json'), 'utf8')),
  meta: JSON.parse(readFileSync(path.join(root, 'data/meta.json'), 'utf8')),
  google: JSON.parse(readFileSync(path.join(root, 'data/google.json'), 'utf8'))
});
const mime = {'.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8'};
const port = Number(process.env.PORT || 3000);

function sendJson(res, status, data) {
  res.writeHead(status, {'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store'});
  res.end(JSON.stringify(data));
}

export const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    if (req.method !== 'GET') return sendJson(res, 405, {error: 'METHOD_NOT_ALLOWED'});
    if (url.pathname === '/health') return sendJson(res, 200, {status: 'ok'});
    if (url.pathname === '/api/summary') return sendJson(res, 200, getSummary(feeds, url.searchParams));
    if (url.pathname === '/api/campaigns') return sendJson(res, 200, getCampaigns(feeds, url.searchParams));

    // 정적 파일: 허용된 4개 경로만 제공 (임의 경로로 서버 파일을 읽지 못하도록)
    const assets = {'/': 'index.html', '/index.html': 'index.html', '/styles.css': 'styles.css', '/app.js': 'app.js'};
    if (assets[url.pathname]) {
      const asset = path.join(root, 'public', assets[url.pathname]);
      return readFile(asset, (err, data) => {
        if (err) return sendJson(res, 404, {error: 'NOT_FOUND'});
        res.writeHead(200, {'content-type': mime[path.extname(asset)] || 'text/plain'});
        res.end(data);
      });
    }
    return sendJson(res, 404, {error: 'NOT_FOUND'});
  } catch (error) {
    // 잘못된 조회 조건 → 400 (analytics.js의 parseQuery에서 발생)
    if (error instanceof InvalidQueryError) {
      return sendJson(res, 400, {error: 'INVALID_QUERY', message: error.message});
    }
    // 그 외(원본 데이터 형식 오류 등) → 500, 상세 내용은 서버 로그에만 남김
    console.error(error);
    return sendJson(res, 500, {error: 'INTERNAL_ERROR', message: '서버 로그를 확인하세요.'});
  }
});

// `node server.js`(= npm start)로 직접 실행했을 때만 서버를 띄웁니다.
// 테스트에서 import할 때는 listen하지 않고, 테스트가 원하는 포트로 직접 띄웁니다.
// (Windows는 경로의 대소문자가 다르게 들어올 수 있어 소문자로 비교)
const samePath = (a, b) => process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
if (process.argv[1] && samePath(path.resolve(process.argv[1]), fileURLToPath(import.meta.url))) {
  server.listen(port, '127.0.0.1', () => console.log(`AQNET test server: http://localhost:${port}`));
}
