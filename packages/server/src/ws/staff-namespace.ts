import type { Namespace } from 'socket.io';
import type { PresenceService } from '../presence/presence-service.js';
import type { Db } from '../db/index.js';
import type { AuthedSocket } from './index.js';
import { visibleTargets } from '../permission/permission-filter.js';
import { findPersonByTag, findTagByPerson } from '../db/index.js';

/**
 * namespace: /staff (설계서 7)
 * 모든 push 는 visibleTargets() 를 거친다 — 권한 필터링은 100% 서버에서.
 */
export function registerStaffNamespace(ns: Namespace, presence: PresenceService, db: Db): void {
  const tagOwner = (tagId: string) => {
    const p = findPersonByTag(db, tagId);
    return p ? { personId: p.personId, dept: p.dept } : null;
  };

  ns.on('connection', (rawSocket) => {
    const socket = rawSocket as AuthedSocket;

    // 접속 직후 현재 스냅샷 (권한 내)
    socket.emit('presence:update', visibleTargets(socket.claims, presence.getAllStates(), tagOwner));

    socket.on('person:locate', ({ personId }: { personId: string }) => {
      const tagId = findTagByPerson(db, personId);
      if (!tagId) return;
      const state = presence.getAllStates().find((s) => s.tagId === tagId);
      if (!state) return;
      // 권한 검사: 이 viewer 가 볼 수 있는 대상인지 확인 후에만 응답
      const visible = visibleTargets(socket.claims, [state], tagOwner);
      if (visible.length > 0) socket.emit('presence:update', visible);
    });

    socket.on('filter:set', (_p: { zoneId?: string; dept?: string }) => {
      // TODO Phase 3: 클라이언트별 필터 저장 → presence:update 시 적용
    });
  });

  // 존 변경 브로드캐스트 — 소켓별로 권한 필터 적용해 개별 전송
  presence.onChange((change) => {
    for (const [, rawSocket] of ns.sockets) {
      const socket = rawSocket as AuthedSocket;
      const state = presence.getAllStates().find((s) => s.tagId === change.tagId);
      if (!state) continue;

      if (change.toZone === null) {
        socket.emit('presence:remove', { tagId: change.tagId });
        continue;
      }

      const visible = visibleTargets(socket.claims, [state], tagOwner);
      if (visible.length > 0) {
        socket.emit('presence:update', visible);
        if (change.personId && change.durationSec !== null && change.fromZone) {
          socket.emit('waittime:update', {
            personId: change.personId,
            zone: change.fromZone,
            durationSec: change.durationSec,
          });
        }
      }
    }
  });
}
