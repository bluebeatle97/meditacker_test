import type { Namespace } from 'socket.io';
import type { PresenceService } from '../presence/presence-service.js';
import type { Db } from '../db/index.js';
import type { AuthedSocket } from './index.js';
import { anonymousOccupancy } from '../permission/permission-filter.js';
import { actionsForZone, isAllowedReaction } from '../social/zone-actions.js';

/**
 * namespace: /patient (설계서 7)
 *
 * 불변식 B-1: 이 namespace 로는 타인의 위치 좌표가 절대 나가지 않는다.
 * 전송 허용: 본인 존 / 대기순번 / 예상시간 / 같은 존 익명 인원수 / 존 액션 / 존 채팅.
 */
export function registerPatientNamespace(ns: Namespace, presence: PresenceService, db: Db): void {
  // tagId → personId 역매핑은 접속 시점 조회로 단순화 (환자 수십 명 규모)
  const socketsByPerson = new Map<string, AuthedSocket>();

  ns.on('connection', (rawSocket) => {
    const socket = rawSocket as AuthedSocket;
    const { personId } = socket.claims;
    socketsByPerson.set(personId, socket);

    socket.on('reaction:send', ({ emoji }: { emoji: string }) => {
      if (!isAllowedReaction(emoji)) return;
      const zone = currentZoneOf(personId);
      if (!zone) return;
      // 같은 존 room 한정 브로드캐스트 — 익명 별칭
      ns.to(`zone:${zone}`).emit('reaction', { alias: aliasOf(personId), emoji, ts: Date.now() });
    });

    socket.on('chat:send', (_p: { text: string }) => {
      // TODO Phase 4: 모더레이션(금칙어·신고) 갖춘 뒤 오픈 (설계서 6.4)
    });

    socket.on('action:invoke', (_p: { actionId: string }) => {
      // TODO Phase 4: 체크인 등 존 액션 처리
    });

    socket.on('disconnect', () => {
      socketsByPerson.delete(personId);
    });
  });

  // 존 변경 시: 본인에게만 presence:self + 존 room join/leave + 존 액션 push
  presence.onChange((change) => {
    if (!change.personId) return;
    const socket = socketsByPerson.get(change.personId);
    if (!socket) return;

    if (change.fromZone) socket.leave(`zone:${change.fromZone}`);
    if (change.toZone) {
      socket.join(`zone:${change.toZone}`); // 물리공간 = 소셜공간 일치 (설계서 6.4)
      socket.emit('zone:actions', actionsForZone(change.toZone));
    }

    socket.emit('presence:self', {
      zone: change.toZone,
      waitingRank: 0, // TODO Phase 2: 대기열 로직
      estimatedWaitSec: 0,
    });

    // 같은 존 인원수(익명) — 좌표 아님
    if (change.toZone) {
      ns.to(`zone:${change.toZone}`).emit('zone:occupancy', {
        zoneId: change.toZone,
        anonymousCount: anonymousOccupancy(change.toZone, presence.getAllStates()),
      });
    }
  });

  function currentZoneOf(personId: string): string | null {
    const row = db
      .prepare(`SELECT tag_id FROM tags WHERE person_id = ? AND active = 1`)
      .get(personId) as { tag_id: string } | undefined;
    if (!row) return null;
    return presence.getAllStates().find((s) => s.tagId === row.tag_id)?.currentZone ?? null;
  }

  function aliasOf(personId: string): string {
    // 익명 별칭 — 실명 노출 금지 (설계서 6.4)
    return `환자 ${personId.slice(-4)}`;
  }
}
