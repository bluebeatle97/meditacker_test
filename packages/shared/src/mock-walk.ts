/**
 * 가상 인원의 동선 타임라인 — "이 경로를 타는 사람은 t초에 어디 있나".
 *
 * 목 게이트웨이(서버, 이 좌표로 RSSI 를 만든다)와 브라우저 시연 모드(좌표를 그대로
 * 화면에 먹인다)가 **같은 함수**를 써야 한다. 두 벌로 두면 시연에서 본 움직임과
 * 목 게이트웨이로 검증한 움직임이 서로 달라진다.
 *
 * 좌표계는 도면 이미지 픽셀. 경로는 존 중심을 순서대로 경유하고, 끝나면 처음으로 돈다.
 */

/** 도면 축척: 1px ≈ 1.62cm (도면 폭 1650px ≈ 26700mm) */
export const CM_PER_PX = 1.62;
/** 성인 보행 1.4m/s 를 도면 px/초로 */
export const MOCK_WALK_PX_PER_SEC = 140 / CM_PER_PX;

export interface RouteStop {
  zoneId: string;
  /** 도착해서 머무는 시간(초) */
  pause: number;
}

interface Waypoint {
  x: number;
  y: number;
  pause: number;
}

interface Segment {
  from: Waypoint;
  to: Waypoint;
  startSec: number;
  durationSec: number;
  /** false = 그 자리에 머무는 구간 */
  moving: boolean;
}

export interface RouteTimeline {
  segments: Segment[];
  totalSec: number;
  first: Waypoint;
}

/** 머무름 → 이동 → 머무름 … 을 시간축에 펼친다 (마지막 지점에서 첫 지점으로 순환) */
function buildTimeline(route: Waypoint[]): RouteTimeline {
  const segments: Segment[] = [];
  let t = 0;
  for (let i = 0; i < route.length; i++) {
    const cur = route[i];
    const next = route[(i + 1) % route.length];
    segments.push({ from: cur, to: cur, startSec: t, durationSec: cur.pause, moving: false });
    t += cur.pause;
    const walkSec = Math.hypot(next.x - cur.x, next.y - cur.y) / MOCK_WALK_PX_PER_SEC;
    segments.push({ from: cur, to: next, startSec: t, durationSec: walkSec, moving: true });
    t += walkSec;
  }
  return { segments, totalSec: t, first: route[0] };
}

/**
 * 경로 이름 → 타임라인. 여러 태그가 같은 타임라인을 오프셋만 달리해서 공유한다
 * (16명이 제각기 계산할 이유가 없다).
 *
 * @param zoneCenter 존 id → 도면 좌표. 경로에 없는 존이 나오면 바로 던진다 —
 *                   조용히 건너뛰면 아무도 안 나타나는 이유를 찾느라 한참 걸린다.
 */
export function buildRouteTimelines(
  routes: Record<string, RouteStop[]>,
  zoneCenter: Map<string, { x: number; y: number }>,
): Map<string, RouteTimeline> {
  const out = new Map<string, RouteTimeline>();
  for (const [name, stops] of Object.entries(routes)) {
    const waypoints = stops.map(({ zoneId, pause }) => {
      const c = zoneCenter.get(zoneId);
      if (!c) throw new Error(`목 경로 '${name}' 에 없는 존: ${zoneId}`);
      return { x: c.x, y: c.y, pause };
    });
    out.set(name, buildTimeline(waypoints));
  }
  return out;
}

/** 시나리오 시각(초) → 현재 좌표와 이동 중 여부 */
export function positionAt(
  tl: RouteTimeline,
  sec: number,
): { x: number; y: number; moving: boolean } {
  const t = ((sec % tl.totalSec) + tl.totalSec) % tl.totalSec;
  for (const seg of tl.segments) {
    if (t < seg.startSec || t >= seg.startSec + seg.durationSec) continue;
    if (!seg.moving) return { x: seg.from.x, y: seg.from.y, moving: false };
    const p = (t - seg.startSec) / seg.durationSec;
    return {
      x: seg.from.x + (seg.to.x - seg.from.x) * p,
      y: seg.from.y + (seg.to.y - seg.from.y) * p,
      moving: true,
    };
  }
  return { x: tl.first.x, y: tl.first.y, moving: false };
}
