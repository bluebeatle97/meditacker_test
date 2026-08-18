/**
 * 직원용 화면의 서버 호출 — staff 토큰을 붙여 보낸다.
 *
 * **왜 한 곳으로 모으나.** 직원 전용 API 는 전부 토큰을 요구한다(서버 `index.ts` 의
 * `STAFF_ONLY`). 호출처마다 헤더를 손으로 붙이면 한 군데 빠뜨렸을 때 그 기능만 조용히
 * 401 이 되고, 화면은 "서버에 연결할 수 없습니다" 같은 엉뚱한 말을 한다. 원인을 찾는 데
 * 한참 걸리는 종류의 버그다.
 *
 * ⚠️ 불변식 B-5: 토큰을 브라우저 스토리지에 저장하지 않는다 — 메모리에만 둔다.
 *    새로고침하면 핀을 다시 묻는다 (`pin-gate.ts`).
 */
let token = '';

export function setStaffToken(t: string): void {
  token = t;
}

/** 소켓 접속(`io(..., { auth: { token } })`)에도 같은 값을 쓴다 */
export function staffToken(): string {
  return token;
}

/**
 * `fetch` 자리에 그대로 끼워 쓴다. 토큰이 없으면(시연 모드 등) 그냥 보낸다 —
 * 공개 경로는 토큰 없이도 답하므로 도면은 계속 뜬다.
 *
 * ⚠️ `Authorization` 헤더가 붙으면 브라우저가 CORS 프리플라이트(OPTIONS)를 먼저 던진다.
 *    서버에 OPTIONS 핸들러가 있어야 하고(있다 — `index.ts` 맨 위), 없으면 5173→8080 이
 *    통째로 막힌다.
 */
export function authFetch(url: string, init: RequestInit = {}): Promise<Response> {
  if (!token) return fetch(url, init);
  return fetch(url, {
    ...init,
    headers: { ...(init.headers ?? {}), Authorization: `Bearer ${token}` },
  });
}
