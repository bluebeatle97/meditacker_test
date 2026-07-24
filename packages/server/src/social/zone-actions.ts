import type { ZoneAction } from '@meditracker/shared';

/**
 * 존 액션 정의 (설계서 6.4) — 존 진입 시 서버가 가능 액션 목록 push.
 * 1단계는 이모티콘/정형 리액션만. 자유채팅은 모더레이션 갖춘 뒤 오픈.
 */
const ZONE_ACTIONS: ZoneAction[] = [
  { actionId: 'waiting_rank', zoneId: 'waiting_main', label: '대기순번 보기', type: 'info' },
  { actionId: 'waiting_reaction', zoneId: 'waiting_main', label: '이모티콘', type: 'reaction' },
  { actionId: 'waiting_faq', zoneId: 'waiting_main', label: '자주 묻는 질문', type: 'faq' },
  { actionId: 'reception_checkin', zoneId: 'reception', label: '체크인', type: 'checkin' },
];

export function actionsForZone(zoneId: string): ZoneAction[] {
  return ZONE_ACTIONS.filter((a) => a.zoneId === zoneId);
}

/** 1단계 허용 이모티콘 화이트리스트 (자유채팅 전 단계) */
export const ALLOWED_REACTIONS = ['👍', '🙂', '😴', '☕', '❓'] as const;

export function isAllowedReaction(emoji: string): boolean {
  return (ALLOWED_REACTIONS as readonly string[]).includes(emoji);
}
