import { defineConfig } from 'vite';

/**
 * 직원용 화면의 배포 위치.
 *
 * - 서버가 화면까지 서빙하는 배포: 루트(`/`) — 기본값
 * - GitHub Pages: 저장소 하위 경로 (`/<저장소이름>/`) → `DEPLOY_BASE` 로 넘긴다
 *
 * base 가 틀리면 빌드된 HTML 이 JS·이미지를 엉뚱한 곳에서 찾아 흰 화면이 된다.
 */
export default defineConfig({
  base: process.env.DEPLOY_BASE ?? '/',
});
