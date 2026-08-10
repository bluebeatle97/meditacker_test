import { DemoSim, MOCK_TAGS, isPrivateRoom } from '@meditracker/shared';
import type { Zone } from '@meditracker/shared';

/**
 * 서버 없이 화면만 띄우는 시연 모드 (GitHub Pages 등 정적 호스팅용).
 * 직원용의 같은 이름 파일과 짝이다 — 여기서는 `/patient` namespace 이벤트를 흉내 낸다.
 *
 * ⚠️ **불변식 B-1 을 여기서도 지킨다.** 환자 화면에는 손님 비콘만 나간다 — 직원 좌표는
 *    익명으로도 내보내지 않는다(서버 patient-namespace 와 같은 규칙). 시연이라고
 *    느슨하게 하면 그 화면이 그대로 사양처럼 굳는다.
 *
 * ⚠️ **불변식 B-5**: 캐릭터 선택을 브라우저 스토리지에 저장하지 않는다. 서버가 없으므로
 *    메모리에만 들고 있고, 새로고침하면 다시 고른다.
 */

const PROBE_TIMEOUT_MS = 3500;
/** 좌표 방송 주기 — 서버 posBroadcastMs 와 같아야 캐릭터 보행 속도가 맞는다 */
const POS_BROADCAST_MS = 1500;
/** 구역 인원수 방송 주기 (서버 CROWD_INTERVAL_MS 와 동일) */
const CROWD_INTERVAL_MS = 2000;

export interface FakeSocket {
  connected: boolean;
  on(event: string, handler: (...args: never[]) => void): void;
  emit(event: string, ...args: unknown[]): void;
  disconnect(): void;
}

export function localConfigUrl(name: string): string {
  return `${import.meta.env.BASE_URL}config/${name}.json`;
}

/**
 * 존 목록을 서버에서 받아 보고, 안 되면 빌드에 든 사본으로 돌아간다.
 *
 * ⚠️ 탐지 전용 요청(`/health`)으로 판단하면 안 된다. 그 하나에만 CORS 헤더가 빠져도
 *    서버가 멀쩡한데 브라우저가 응답을 막아 '서버 없음'으로 오진한다 — 개발 모드가
 *    조용히 시연 모드로 빠졌던 실제 사고다. 진짜 쓰는 것을 받아 보면 그럴 수 없다.
 */
export async function resolveZones(serverUrl: string): Promise<{ demo: boolean; zones: Zone[] }> {
  try {
    const res = await fetch(`${serverUrl}/zones`, {
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
    if (res.ok) return { demo: false, zones: (await res.json()) as Zone[] };
  } catch {
    /* 서버 없음 — 아래에서 사본을 쓴다 */
  }
  const local = await fetch(localConfigUrl('zones'));
  return { demo: true, zones: (await local.json()) as Zone[] };
}

/** 서버의 anonId 와 같은 해시 — 같은 태그면 같은 id 라야 스프라이트가 유지된다 */
function anonId(tagId: string): string {
  let h = 0;
  for (let i = 0; i < tagId.length; i++) h = (h * 31 + tagId.charCodeAt(i)) | 0;
  return `u${(h >>> 0).toString(36)}`;
}

/**
 * 시연용 가짜 소켓 — 본인 좌표·다른 손님들·구역 인원수·대기 안내를 흘린다.
 * 서버와 같은 주기·같은 페이로드라 화면 쪽 핸들러는 손댈 필요가 없다.
 */
export function demoSocket(zones: Zone[]): FakeSocket {
  const sim = new DemoSim(zones);
  const guests = new Set(
    MOCK_TAGS.filter((t) => t.route.startsWith('patient') || t.route.startsWith('waiting')).map(
      (t) => t.mac,
    ),
  );
  const me = sim.demoPatientTag;
  /** 여기 있는 손님은 다른 손님 화면에 안 나온다 (서버와 같은 규칙) */
  const privateZones = new Set(zones.filter(isPrivateRoom).map((z) => z.zoneId));
  const handlers = new Map<string, Array<(...args: never[]) => void>>();
  const timers: Array<ReturnType<typeof setInterval>> = [];

  const fire = (event: string, payload: unknown): void => {
    for (const h of handlers.get(event) ?? []) (h as (p: unknown) => void)(payload);
  };

  const socket: FakeSocket = {
    connected: true,
    on(event, handler) {
      handlers.set(event, [...(handlers.get(event) ?? []), handler]);
    },
    emit() {}, // 화면 → 서버 방향은 받을 곳이 없다 (채팅·리액션은 시연 모드에 없다)
    disconnect() {
      for (const t of timers) clearInterval(t);
      socket.connected = false;
    },
  };

  let lastZone: string | null = null;

  const tick = (): void => {
    const all = sim.positions();
    const self = all.find((p) => p.tagId === me);
    if (self) {
      fire('pos:self', { x: self.x, y: self.y, zone: self.zone, inTransit: self.inTransit });
      // 구역이 바뀔 때만 나가는 이벤트 — 서버와 같은 조건으로 흘린다
      if (self.zone !== lastZone) {
        lastZone = self.zone;
        fire('presence:self', { zone: self.zone, ...waitingFor(self.zone) });
      }
    }
    fire(
      'crowd:positions',
      all
        .filter((p) => guests.has(p.tagId) && p.tagId !== me)
        // 서버(patient-namespace 의 visibleToOtherPatients)와 같은 규칙 —
        // 시연이라고 느슨하게 두면 그 화면이 그대로 사양처럼 굳는다
        .filter((p) => !p.zone || p.inTransit || !privateZones.has(p.zone))
        .map((p) => ({ id: anonId(p.tagId), x: p.x, y: p.y, kind: 'patient' as const })),
    );
  };

  /**
   * 대기 순번·예상 시간은 서버가 대기열을 보고 계산하던 값이라 여기선 만들 수 없다.
   * 대기공간에 있을 때만 그럴듯한 숫자를 보여주고 그 외에는 0(=안내 없음)으로 둔다 —
   * 아무 방에서나 순번이 뜨면 그게 더 이상하다.
   */
  const waitingFor = (zone: string | null): { waitingRank: number; estimatedWaitSec: number } => {
    if (!zone?.startsWith('waiting')) return { waitingRank: 0, estimatedWaitSec: 0 };
    const ahead = sim.positions().filter((p) => guests.has(p.tagId) && p.zone === zone).length;
    return { waitingRank: Math.max(1, ahead), estimatedWaitSec: ahead * 8 * 60 };
  };

  queueMicrotask(() => {
    tick();
    timers.push(setInterval(tick, POS_BROADCAST_MS));
    timers.push(
      setInterval(() => {
        if (!lastZone) return;
        const n = sim.positions().filter((p) => guests.has(p.tagId) && p.zone === lastZone).length;
        fire('zone:occupancy', { zoneId: lastZone, anonymousCount: n });
      }, CROWD_INTERVAL_MS),
    );
  });

  return socket;
}

/**
 * 시연 모드 표시. 움직임이 진짜와 구분이 안 되므로 배지는 선택이 아니다.
 */
export function markDemoUi(): void {
  const badge = document.createElement('div');
  badge.id = 'demo-badge';
  badge.innerHTML =
    '<b>시연용 가상 데이터</b><span>서버 없이 화면만 동작합니다 — 실제 비콘 추적이 아닙니다</span>';
  document.body.appendChild(badge);
}
