import type { Namespace } from 'socket.io';
import type { PresenceService } from '../presence/presence-service.js';
import type { Db } from '../db/index.js';
import type { AuthedSocket } from './index.js';
import { anonymousOccupancy } from '../permission/permission-filter.js';
import { actionsForZone, isAllowedReaction } from '../social/zone-actions.js';
import { loadZones } from '../config/index.js';
import { findPersonByTag } from '../db/index.js';
import type { PersonType } from '@meditracker/shared';

/** index.ts 가 위치 브로드캐스트를 밀어 넣는 창구 */
export interface PatientBroadcast {
  crowdPositions(list: Array<{ tagId: string; x: number; y: number; zone: string | null }>): void;
}

/** 몇 초마다 구역별 인원수를 내보낼지 (좌표가 아니라 수만 — 자주 보내도 정보량이 작다) */
const CROWD_INTERVAL_MS = 2000;

/**
 * namespace: /patient (설계서 7)
 *
 * 불변식 B-1: 이 namespace 로는 타인의 **위치 좌표**가 절대 나가지 않는다.
 * 전송 허용: 본인 존 / 대기순번 / 예상시간 / 존 액션 / 존 채팅
 *   + 익명 인원수 — 같은 존(zone:occupancy)과 **환자 이용 구역 전체**(zone:crowd).
 *
 * zone:crowd 는 '어느 방에 몇 명'만 담는다. 신분·좌표가 없어 특정인을 따라갈 수 없고,
 * 복도를 걸으며 눈으로 보는 것과 같은 수준이다. 직원 전용 구역은 빼서
 * 직원 동선이 환자에게 드러나지 않게 한다.
 */
export function registerPatientNamespace(
  ns: Namespace,
  presence: PresenceService,
  db: Db,
): PatientBroadcast {
  // tagId → personId 역매핑은 접속 시점 조회로 단순화 (환자 수십 명 규모)
  const socketsByPerson = new Map<string, AuthedSocket>();
  /** 소켓별 본인 태그 — 남들 목록에서 자기 자신을 빼는 데 쓴다 */
  const ownTag = new Map<string, string | null>();
  // 환자가 다닐 수 있는 구역만 인원수를 공개한다 (직원 전용 구역 제외)
  const publicZones = new Set(
    loadZones()
      .filter((z) => z.category !== 'staff_area')
      .map((z) => z.zoneId),
  );

  /** 구역별 익명 인원수 (0인 구역은 생략) */
  function crowd(): Array<{ zoneId: string; count: number }> {
    const counts = new Map<string, number>();
    for (const st of presence.getAllStates()) {
      if (!st.currentZone || !publicZones.has(st.currentZone)) continue;
      counts.set(st.currentZone, (counts.get(st.currentZone) ?? 0) + 1);
    }
    return [...counts].map(([zoneId, count]) => ({ zoneId, count }));
  }

  // 주기 브로드캐스트 — 모든 환자에게 같은 값이라 소켓별 계산이 필요 없다.
  // patientSeesEveryone 을 끄면(운영 기본) 환자는 좌표 대신 이 인원수만 받는다.
  setInterval(() => {
    if (ns.sockets.size === 0) return;
    ns.emit('zone:crowd', crowd());
  }, CROWD_INTERVAL_MS);

  ns.on('connection', (rawSocket) => {
    const socket = rawSocket as AuthedSocket;
    const { personId } = socket.claims;
    socketsByPerson.set(personId, socket);

    // 접속 직후 현재 상태 1회 — presence.onChange 만 기다리면 존이 바뀔 때까지
    // 화면이 '위치를 확인하는 중…' 에 머문다 (본인 존이므로 불변식 B-1 위반 아님)
    const zone = currentZoneOf(personId);
    if (zone) {
      socket.join(`zone:${zone}`);
      socket.emit('zone:actions', actionsForZone(zone));
      // 같은 구역 인원수(익명) — 좌표가 아니라 '몇 명'만 나간다 (불변식 B-1)
      socket.emit('zone:occupancy', {
        zoneId: zone,
        anonymousCount: anonymousOccupancy(zone, presence.getAllStates()),
      });
    }
    socket.emit('presence:self', {
      zone,
      waitingRank: 0, // TODO Phase 2: 대기열 로직
      estimatedWaitSec: 0,
    });
    socket.emit('zone:crowd', crowd()); // 접속 직후 1회 — 주기 방송을 기다리지 않게
    ownTag.set(socket.id, tagOf(personId));

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
      ownTag.delete(socket.id);
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

  function tagOf(personId: string): string | null {
    const row = db
      .prepare(`SELECT tag_id FROM tags WHERE person_id = ? AND active = 1`)
      .get(personId) as { tag_id: string } | undefined;
    return row?.tag_id ?? null;
  }

  function currentZoneOf(personId: string): string | null {
    const tagId = tagOf(personId);
    if (!tagId) return null;
    return presence.getAllStates().find((s) => s.tagId === tagId)?.currentZone ?? null;
  }

  function aliasOf(personId: string): string {
    // 익명 별칭 — 실명 노출 금지 (설계서 6.4)
    return `환자 ${personId.slice(-4)}`;
  }

  return {
    /**
     * 다른 사람들의 위치를 환자 화면으로 보낸다 (SERVER_CONFIG.patientSeesEveryone 이 켜졌을 때만).
     *
     * 나가는 것: **익명 id + 좌표 + 손님/직원 구분**. 태그 MAC·이름·personId 는 절대 안 나간다.
     * 소켓마다 본인은 빼고 보낸다 — 본인 캐릭터는 presence:self 로 이미 그려져 있다.
     */
    crowdPositions(list: Array<{ tagId: string; x: number; y: number; zone: string | null }>): void {
      if (ns.sockets.size === 0) return;
      const units = list.map((p) => ({
        id: anonId(p.tagId),
        x: p.x,
        y: p.y,
        kind: (findPersonByTag(db, p.tagId)?.type ?? 'patient') as PersonType,
        tagId: p.tagId, // 소켓별 자기 자신 제외에만 쓰고 아래에서 제거한다
      }));
      for (const [, rawSocket] of ns.sockets) {
        const socket = rawSocket as AuthedSocket;
        const mine = ownTag.get(socket.id);
        socket.emit(
          'crowd:positions',
          units.filter((u) => u.tagId !== mine).map(({ tagId: _drop, ...u }) => u),
        );
      }
    },
  };
}

/** 태그 식별자를 화면용 익명 id 로 — 같은 태그면 같은 id (스프라이트가 유지되도록) */
function anonId(tagId: string): string {
  let h = 0;
  for (let i = 0; i < tagId.length; i++) h = (h * 31 + tagId.charCodeAt(i)) | 0;
  return `u${(h >>> 0).toString(36)}`;
}
