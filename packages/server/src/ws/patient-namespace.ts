import type { Namespace } from 'socket.io';
import type { PresenceService } from '../presence/presence-service.js';
import { findTagByPerson, type Db } from '../db/index.js';
import type { AuthedSocket } from './index.js';
import { anonymousOccupancy } from '../permission/permission-filter.js';
import { actionsForZone, isAllowedReaction } from '../social/zone-actions.js';
import { loadZones, SERVER_CONFIG } from '../config/index.js';
import type { TagMetaStore } from '../presence/tag-meta-store.js';

/** index.ts 가 위치 브로드캐스트를 밀어 넣는 창구 */
export interface PatientBroadcast {
  /**
   * 방 안내를 **그 환자 한 명에게만** 보낸다.
   * `zoneId` 가 null 이면 안내 해제 (도착했거나 직원이 껐거나).
   */
  guide(tagId: string, zoneId: string | null): void;
  positions(
    list: Array<{
      tagId: string;
      x: number;
      y: number;
      zone: string | null;
      inTransit?: boolean;
    }>,
  ): void;
}

/** 몇 초마다 구역별 인원수를 내보낼지 (좌표가 아니라 수만 — 자주 보내도 정보량이 작다) */
const CROWD_INTERVAL_MS = 2000;

/**
 * namespace: /patient (설계서 7)
 *
 * 이 namespace 로 나가는 남의 정보는 **손님 비콘으로 한정**한다.
 * 의사·간호사·통역·미지정 태그는 좌표도 인원수도 나가지 않는다 — 환자 화면에서
 * 직원 동선을 들여다볼 수 있으면 노무 문제가 된다(설계서 12).
 *
 * 전송 허용: 본인 존·좌표 / 대기순번 / 예상시간 / 존 액션 / 존 채팅
 *   + 손님 익명 인원수(zone:occupancy, zone:crowd)
 *   + 손님 익명 좌표(crowd:positions) — SERVER_CONFIG.patientSeesEveryone 이 켜진 동안만.
 *     ⚠️ 이 항목이 설계서 불변식 B-1 을 벗어나는 부분이다 (스위치로 끌 수 있음).
 */
export function registerPatientNamespace(
  ns: Namespace,
  presence: PresenceService,
  db: Db,
  tagMeta: TagMetaStore,
  guideOf: (tagId: string) => string | null,
): PatientBroadcast {
  /**
   * 환자 화면에 보일 수 있는 태그인가 = **손님 비콘만**.
   * 의사·간호사·통역·미지정은 좌표도 인원수도 나가지 않는다 — 환자가 직원 동선을
   * 들여다볼 수 있으면 노무 문제이기도 하다(설계서 12 권한 매트릭스).
   */
  const isGuest = (tagId: string): boolean => tagMeta.all()[tagId]?.group === 'patient';
  const guestStates = () => presence.getAllStates().filter((s) => isGuest(s.tagId));
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
    for (const st of guestStates()) {
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
        anonymousCount: anonymousOccupancy(zone, guestStates()),
      });
    }
    socket.emit('presence:self', {
      zone,
      waitingRank: 0, // TODO Phase 2: 대기열 로직
      estimatedWaitSec: 0,
    });
    socket.emit('zone:crowd', crowd()); // 접속 직후 1회 — 주기 방송을 기다리지 않게
    const own = tagOf(personId);
    ownTag.set(socket.id, own);
    // 안내 중에 환자가 화면을 새로고침하면 화살표가 사라진다 — 접속하자마자 다시 준다
    const already = own ? guideOf(own) : null;
    if (already) socket.emit('guide:set', { zoneId: already });

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
        anonymousCount: anonymousOccupancy(change.toZone, guestStates()),
      });
    }
  });

  function tagOf(personId: string): string | null {
    return findTagByPerson(db, personId);
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
     * 방 안내 — 지시받은 비콘을 들고 있는 소켓에만 간다.
     * 남의 안내를 다른 환자가 볼 이유가 없다(불변식 B-1 과 같은 결).
     */
    guide(tagId: string, zoneId: string | null): void {
      for (const [, rawSocket] of ns.sockets) {
        const socket = rawSocket as AuthedSocket;
        if (ownTag.get(socket.id) !== tagId) continue;
        socket.emit('guide:set', zoneId ? { zoneId } : null);
      }
    },

    /**
     * 환자 화면으로 위치를 보낸다.
     *
     * - `pos:self` — **본인 좌표**. 항상 보낸다 (본인 위치라 불변식 B-1 과 무관).
     * - `crowd:positions` — **다른 손님들만**. `patientSeesEveryone` 이 켜졌을 때만.
     *   나가는 것은 익명 id + 좌표뿐 — MAC·이름·personId 는 안 나간다.
     */
    positions(
      list: Array<{
        tagId: string;
        x: number;
        y: number;
        zone: string | null;
        inTransit?: boolean;
      }>,
    ): void {
      if (ns.sockets.size === 0) return;
      // 손님 비콘만 내보낸다 — 직원 좌표는 환자 화면으로 나가지 않는다
      const units = list
        .filter((p) => isGuest(p.tagId))
        .map((p) => ({
          id: anonId(p.tagId),
          x: p.x,
          y: p.y,
          kind: 'patient' as const,
          tagId: p.tagId, // 소켓별 자기 자신 제외에만 쓰고 아래에서 제거한다
        }));
      for (const [, rawSocket] of ns.sockets) {
        const socket = rawSocket as AuthedSocket;
        const mine = ownTag.get(socket.id);
        // 본인 좌표 — 이게 없으면 본인 캐릭터만 존 중앙에 스냅되고,
        // 남들은 실좌표로 움직이는데 정작 나만 안 움직인다 (실제로 그랬다).
        const self = mine ? list.find((p) => p.tagId === mine) : undefined;
        // inTransit 이면 화면은 방 이름 대신 '이동 중' 을 띄운다 (복도엔 게이트웨이가 없다)
        if (self) {
          socket.emit('pos:self', {
            x: self.x,
            y: self.y,
            zone: self.zone,
            inTransit: self.inTransit,
          });
        }
        if (!SERVER_CONFIG.patientSeesEveryone) continue;
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
