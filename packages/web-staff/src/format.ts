/** 직원용 화면 DOM 패널들이 함께 쓰는 표시 헬퍼 */

/** 경과 시간을 사람이 읽는 말로 ("42초" / "7분" / "1시간 5분") */
export function agoText(ms: number): string {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}초`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}분`;
  return `${Math.floor(m / 60)}시간 ${m % 60}분`;
}

/** 이름·메모는 운영자가 입력한 값 → innerHTML 에 넣기 전에 반드시 통과시킨다 */
export function escapeHtml(s: string): string {
  return s.replace(/[&<>"]/g, (c) => `&${{ '&': 'amp', '<': 'lt', '>': 'gt', '"': 'quot' }[c]};`);
}
