import { DemoSim } from '@meditracker/shared';
import type { PositionEstimate, TagMetaMap, Zone } from '@meditracker/shared';

/**
 * 서버 없이 화면만 띄우는 시연 모드 (GitHub Pages 등 정적 호스팅용).
 *
 * **동작.** 화면이 뜰 때 서버에 설정을 물어보다 실패하면 이 모드로 넘어간다. 도면·존·벽
 * 격자는 어차피 고정된 파일이라 빌드에 같이 넣어 두고, 사람들의 좌표는 브라우저 안에서
 * 만들어 낸다(`DemoSim`). 소켓 자리에는 같은 모양의 가짜 객체를 끼워 넣으므로
 * **화면 코드는 서버가 있는지 없는지 모른다** — `.on('pos:update')` 가 그대로 동작한다.
 *
 * ⚠️ 여기서 나오는 위치는 **추적 결과가 아니라 미리 정해둔 동선**이다. 겉보기가 진짜와
 *    거의 같으므로 화면에 '시연용 가상 데이터' 배지를 반드시 띄운다 (`markDemoUi`).
 */

/** 서버 응답이 이 시간 안에 안 오면 없는 것으로 친다 — 정적 호스팅에선 대개 즉시 실패한다 */
const PROBE_TIMEOUT_MS = 3500;

/**
 * 서버가 있는지 확인. **화면이 실제로 쓰는 엔드포인트**로 물어본다.
 *
 * ⚠️ 탐지 전용 요청(`/health`)을 쓰면 안 된다. 그 하나에만 CORS 헤더가 빠져도
 *    서버가 멀쩡한데 브라우저가 응답을 막아 통째로 '서버 없음'이 된다 — 개발 모드
 *    (5173→8080)가 조용히 시연 모드로 빠졌던 실제 사고다. 진짜 쓰는 것을 받아 보면
 *    그 종류의 오진이 구조적으로 불가능하다.
 */
async function fetchZones(serverUrl: string): Promise<Zone[] | null> {
  try {
    const res = await fetch(`${serverUrl}/zones`, {
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
    return res.ok ? ((await res.json()) as Zone[]) : null;
  } catch {
    return null;
  }
}

/**
 * 존 목록을 서버에서 받아 보고, 안 되면 빌드에 든 사본으로 돌아간다.
 * 돌려주는 `demo` 가 이후 모든 분기(설정 출처·소켓·배지)의 단일 기준이다.
 */
export async function resolveZones(serverUrl: string): Promise<{ demo: boolean; zones: Zone[] }> {
  const fromServer = await fetchZones(serverUrl);
  if (fromServer) return { demo: false, zones: fromServer };
  const res = await fetch(localConfigUrl('zones'));
  return { demo: true, zones: (await res.json()) as Zone[] };
}

/** 좌표 방송 주기 — 서버의 posBroadcastMs 와 같은 값이라야 아바타 보행 속도가 맞는다 */
const POS_BROADCAST_MS = 1500;

/** 화면이 소켓에서 쓰는 부분만 흉내 낸다 (io() 가 돌려주는 것의 최소 부분집합) */
export interface FakeSocket {
  connected: boolean;
  on(event: string, handler: (...args: never[]) => void): void;
  emit(event: string, ...args: unknown[]): void;
  disconnect(): void;
}

/** 빌드에 같이 들어간 정적 설정 (서버의 /floorplan · /zones · /walkable 과 같은 내용) */
export function localConfigUrl(name: string): string {
  return `${import.meta.env.BASE_URL}config/${name}.json`;
}

/**
 * 시연용 가짜 소켓. 진짜 서버와 같은 주기·같은 페이로드로 이벤트를 흘린다.
 * 화면이 붙인 핸들러를 그대로 불러 주므로 아바타 이동·경고 판정이 다 살아 있다.
 */
export function demoSocket(zones: Zone[]): { socket: FakeSocket; meta: TagMetaMap } {
  const sim = new DemoSim(zones);
  const handlers = new Map<string, Array<(...args: never[]) => void>>();
  let timer: ReturnType<typeof setInterval> | undefined;

  const fire = (event: string, payload: unknown): void => {
    for (const h of handlers.get(event) ?? []) (h as (p: unknown) => void)(payload);
  };

  const socket: FakeSocket = {
    connected: true,
    on(event, handler) {
      handlers.set(event, [...(handlers.get(event) ?? []), handler]);
    },
    // 화면 → 서버 방향은 받을 곳이 없다. 조용히 버린다 (에러를 내면 화면이 죽는다)
    emit() {},
    disconnect() {
      if (timer) clearInterval(timer);
      socket.connected = false;
    },
  };

  // 핸들러가 다 붙은 다음 첫 방송이 나가야 한다 — 붙기 전에 쏘면 아무도 못 듣는다
  queueMicrotask(() => {
    const tick = (): void => fire('pos:update', sim.positions() as PositionEstimate[]);
    fire('tagmeta', sim.tagMeta());
    tick();
    timer = setInterval(tick, POS_BROADCAST_MS);
  });

  return { socket, meta: sim.tagMeta() };
}

/**
 * 시연 모드임을 화면에 표시하고, 서버가 있어야만 되는 것을 감춘다.
 *
 * 배지는 선택이 아니다 — 움직임이 진짜와 구분이 안 되므로 표시가 없으면 보는 사람이
 * 이걸 실제 추적 정확도로 받아들인다.
 */
export function markDemoUi(): void {
  // 관제 페이지는 서버가 HTML 을 만들어 주는 화면이라 시연 모드에는 존재하지 않는다
  document.getElementById('admin-btn')?.remove();

  const badge = document.createElement('div');
  badge.id = 'demo-badge';
  badge.innerHTML =
    '<b>시연용 가상 데이터</b><span>서버 없이 화면만 동작합니다 — 실제 비콘 추적이 아닙니다</span>';
  document.body.appendChild(badge);
}
