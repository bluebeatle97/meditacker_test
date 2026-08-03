import { defineConfig } from 'vite';

/**
 * 환자용 화면의 배포 위치 — 직원용 아래 `/patient/` 에 얹힌다.
 *
 * - 서버가 화면까지 서빙하는 배포: `/patient/`
 * - GitHub Pages: `/<저장소이름>/patient/` → `DEPLOY_BASE` 로 넘긴다
 *
 * 개발 서버(5174)는 루트로 뜨는 게 편하므로 빌드할 때만 적용한다.
 * public/ 자원은 코드에서 `import.meta.env.BASE_URL` 을 붙여 부른다 —
 * 루트 절대경로로 적으면 직원용 쪽을 뒤져 404 가 난다.
 */
export default defineConfig(({ command }) => ({
  base: command === 'build' ? (process.env.DEPLOY_BASE ?? '/patient/') : '/',
}));
