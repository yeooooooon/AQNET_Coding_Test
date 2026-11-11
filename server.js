import http from 'node:http';
import { readFile, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getSummary, getCampaigns, InvalidQueryError } from './src/analytics.js';

const root = path.dirname(fileURLToPath(import.meta.url));
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
    if (error instanceof InvalidQueryError) {
      return sendJson(res, 400, {error: 'INVALID_QUERY', message: error.message});
    }
    if (error?.message === 'NOT_IMPLEMENTED') return sendJson(res, 501, {error: 'NOT_IMPLEMENTED', message: 'src/analytics.js를 구현하세요.'});
    console.error(error);
    return sendJson(res, 500, {error: 'INTERNAL_ERROR', message: '서버 로그를 확인하세요.'});
  }
});

// 테스트에서 import할 때는 listen하지 않고, `node server.js`로 직접 실행할 때만 서버를 띄웁니다.
const samePath = (a, b) => process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
if (process.argv[1] && samePath(path.resolve(process.argv[1]), fileURLToPath(import.meta.url))) {
  server.listen(port, '127.0.0.1', () => console.log(`AQNET test server: http://localhost:${port}`));
}
