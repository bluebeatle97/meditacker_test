import { createReadStream, existsSync, statSync } from 'node:fs';
import { extname, join, resolve, sep } from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';

/**
 * 빌드된 프론트(직원용·환자용)를 서버가 직접 서빙한다.
 *
 * **왜.** 배포처를 하나로 줄이기 위해서다. 화면을 정적 호스팅(GitHub Pages 등)에 따로
 * 올리면 도메인이 갈라져 CORS·소켓 주소·하위경로 설정을 세 군데서 맞춰야 하고, 어느 한
 * 쪽만 재배포되면 조용히 어긋난다. 한 프로세스가 API·소켓·화면을 다 주면 그 문제가 없다.
 *
 * dist 가 없으면 아무것도 안 한다 — 개발 중에는 Vite 개발 서버(5173/5174)가 화면을
 * 맡고 이 서버는 API 만 주는 지금 구조가 그대로 유지된다.
 *
 * ⚠️ 인증은 여기서 하지 않는다. 화면 파일 자체는 비밀이 아니고, 위치 데이터는 소켓·API
 *    쪽 토큰 검사가 막는다. 공개 배포 전 `/dev-token` 을 없애야 하는 이유가 이것이다.
 */

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
};

export interface StaticMount {
  /** URL 접두사. 반드시 '/' 로 끝난다 ('/' 는 루트 = 마지막 후보) */
  prefix: string;
  /** 그 접두사가 가리키는 빌드 결과 폴더 */
  dir: string;
}

/** dist 밖으로 새는 경로(`../`)를 차단 — 없으면 서버 소스가 통째로 노출된다 */
function safeJoin(dir: string, rel: string): string | null {
  const root = resolve(dir);
  const target = resolve(root, `.${rel.startsWith('/') ? rel : `/${rel}`}`);
  return target === root || target.startsWith(root + sep) ? target : null;
}

function send(res: ServerResponse, file: string, headOnly: boolean, cache: string): void {
  const type = MIME[extname(file).toLowerCase()] ?? 'application/octet-stream';
  res.writeHead(200, {
    'Content-Type': type,
    'Content-Length': statSync(file).size,
    'Cache-Control': cache,
  });
  if (headOnly) {
    res.end();
    return;
  }
  createReadStream(file).pipe(res);
}

/**
 * 정적 파일 핸들러. **처리했으면 true**, 아니면 false 를 돌려주므로
 * 호출 쪽에서 API 라우트를 전부 지나온 뒤 마지막에 한 번만 물어보면 된다.
 */
export function createStaticHandler(
  mounts: StaticMount[],
): (req: IncomingMessage, res: ServerResponse) => boolean {
  // 빌드 안 된 화면은 아예 후보에서 뺀다 (개발 모드에서 index.html 을 잘못 뱉지 않게)
  const live = mounts
    .filter((m) => existsSync(join(m.dir, 'index.html')))
    .sort((a, b) => b.prefix.length - a.prefix.length); // '/patient/' 가 '/' 보다 먼저

  for (const m of live) console.log(`[web] ${m.prefix} → ${m.dir}`);
  if (live.length === 0) console.log('[web] 빌드된 화면 없음 — API 만 서빙 (개발 모드)');

  return (req, res) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') return false;
    let path: string;
    try {
      path = decodeURIComponent(new URL(req.url ?? '/', 'http://localhost').pathname);
    } catch {
      return false; // 잘못된 퍼센트 인코딩 — 404 로 흘려보낸다
    }

    const mount = live.find((m) => path.startsWith(m.prefix) || path === m.prefix.slice(0, -1));
    if (!mount) return false;

    // '/patient' → '/patient/' 로 보정. 안 하면 하위 경로 기준이 어긋나 자원을 못 찾는다
    if (mount.prefix !== '/' && path === mount.prefix.slice(0, -1)) {
      res.writeHead(302, { Location: mount.prefix });
      res.end();
      return true;
    }

    const rel = path.slice(mount.prefix.length);
    const file = rel === '' ? join(mount.dir, 'index.html') : safeJoin(mount.dir, rel);
    const headOnly = req.method === 'HEAD';

    if (file && existsSync(file) && statSync(file).isFile()) {
      // Vite 가 파일명에 해시를 박아 주므로 자원은 영구 캐시해도 안전하다.
      // index.html 은 그 해시를 가리키는 지도라 절대 캐시하면 안 된다.
      const immutable = rel.startsWith('assets/');
      send(res, file, headOnly, immutable ? 'public, max-age=31536000, immutable' : 'no-cache');
      return true;
    }
    // 확장자 없는 경로만 화면으로 되돌린다 (없는 이미지에 HTML 을 주면 디버깅이 괴롭다)
    if (extname(path) === '') {
      send(res, join(mount.dir, 'index.html'), headOnly, 'no-cache');
      return true;
    }
    return false;
  };
}
