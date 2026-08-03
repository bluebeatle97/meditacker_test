import { defineConfig } from 'vite';

/**
 * 환자용 화면은 배포 시 서버의 `/patient/` 아래에 얹힌다 (직원용은 루트).
 * base 를 안 맞추면 빌드된 HTML 이 자원을 `/assets/...` 로 찾아 직원용 것을 집는다.
 *
 * 개발 서버(5174)는 루트로 뜨는 게 편하므로 빌드할 때만 적용한다.
 */
export default defineConfig(({ command }) => ({
  base: command === 'build' ? '/patient/' : '/',
}));
