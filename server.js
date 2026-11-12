/**
 * HTTP 서버 (외부 패키지 없음, node:http)
 * - GET /api/summary   : 기간·매체별 성과 (필수)          → src/summary.js getSummary()
 * - GET /api/campaigns : 캠페인별 성과 (선택 심화, 같은 필터) → src/summary.js getCampaigns()
 * - GET / 등         : public/ 의 대시보드 화면 (같은 서버·같은 포트라 CORS 불필요)
 *                       public/ 폴더 안의 .html·.css·.js만 제공 (폴더 밖 파일 접근 차단)
 *
 * 데이터는 시작 시 한 번 읽어 정규화·중복 제거까지 마친 결과를 메모리에 보관합니다.
 * 데이터 파일 문제(누락·JSON 오류·배열 아님)는 0건으로 숨기지 않고 서버 시작을 실패시킵니다.
 *
 * 환경변수: PORT (기본 3000), DATA_DIR (기본 프로젝트의 data/)
 */
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadFeeds, buildDataset } from './src/dataset.js';
import { getSummary, getCampaigns, InvalidQueryError } from './src/summary.js';

const root = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(root, 'public');
const MIME = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8' };

/** JSON 응답. no-store: 브라우저가 조회 결과를 캐시해 옛 값을 보여 주지 않도록 */
function sendJson(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
}

/**
 * 요청 경로 → public/ 안의 파일 경로. 제공하면 안 되는 경로면 null
 * - "/" → index.html
 * - 실제 위치가 public/ 밖이면 거부 ("/../server.js", "%2e%2e%2f" 같은 경로 탈출 차단)
 * - .html·.css·.js 외의 파일은 거부
 */
function publicFile(pathname) {
  let rel;
  try {
    rel = pathname === '/' ? 'index.html' : decodeURIComponent(pathname.slice(1));
  } catch {
    return null; // 잘못된 % 인코딩
  }
  const full = path.resolve(PUBLIC_DIR, rel);
  if (!full.startsWith(PUBLIC_DIR + path.sep)) return null;
  return MIME[path.extname(full)] ? full : null;
}

/** dataset(정규화 완료 데이터)으로 요청을 처리하는 서버를 만듭니다. 테스트에서도 같은 함수를 사용합니다. */
export function createServer(dataset) {
  return http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://localhost');
      if (req.method !== 'GET') return sendJson(res, 405, { error: 'METHOD_NOT_ALLOWED', message: 'GET만 지원합니다.' });

      if (url.pathname === '/api/summary') return sendJson(res, 200, getSummary(dataset, url.searchParams));
      if (url.pathname === '/api/campaigns') return sendJson(res, 200, getCampaigns(dataset, url.searchParams));

      // 화면 파일 (public/ 안의 .html·.css·.js만)
      const file = publicFile(url.pathname);
      if (file) {
        try {
          const body = await readFile(file);
          res.writeHead(200, { 'content-type': MIME[path.extname(file)] });
          return res.end(body);
        } catch (error) {
          if (error.code !== 'ENOENT' && error.code !== 'EISDIR') throw error; // 없는 파일만 404, 그 외는 500
        }
      }
      return sendJson(res, 404, { error: 'NOT_FOUND', message: `없는 경로입니다: ${url.pathname}` });
    } catch (error) {
      if (error instanceof InvalidQueryError) {
        return sendJson(res, 400, { error: 'INVALID_QUERY', message: error.message });
      }
      console.error(error);
      return sendJson(res, 500, { error: 'INTERNAL_ERROR', message: '서버 오류가 발생했습니다. 서버 로그를 확인하세요.' });
    }
  });
}

/** DATA_DIR의 파일을 읽어 정규화한 dataset을 반환합니다. 파일 문제는 DataFileError를 던집니다. */
export function loadDataset(dataDir) {
  return buildDataset(loadFeeds(dataDir));
}

// `node server.js`(= npm start)로 직접 실행할 때만 서버를 띄웁니다. (테스트에서 import할 때는 실행 안 함)
// Windows는 경로 대소문자가 다르게 들어올 수 있어 소문자로 비교
const isMain = process.argv[1] && path.resolve(process.argv[1]).toLowerCase() === fileURLToPath(import.meta.url).toLowerCase();
if (isMain) {
  const dataDir = path.resolve(process.env.DATA_DIR || path.join(root, 'data'));
  const port = Number(process.env.PORT || 3000);

  // 데이터 파일 문제는 0건으로 띄우지 않고 시작 실패 (종료 코드 1)
  let dataset;
  try {
    dataset = loadDataset(dataDir);
  } catch (error) {
    console.error(`[시작 실패] ${error.message}`);
    process.exit(1);
  }

  const q = dataset.quality;
  console.log(`데이터: ${dataDir} (입력 ${q.inputRows} · 무효 ${q.invalidRows} · 중복 ${q.duplicateRows} · 유효 ${q.validRows})`);
  createServer(dataset).listen(port, () => console.log(`대시보드: http://localhost:${port}  API: http://localhost:${port}/api/summary`));
}
