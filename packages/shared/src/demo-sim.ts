import { MOCK_TAGS, mockProfileFor, ROUTES } from './mock-tags.js';
import { buildRouteTimelines, positionAt, type RouteTimeline } from './mock-walk.js';
import type { PositionEstimate, TagMetaMap, Zone } from './index.js';

/**
 * 서버 없이 브라우저 안에서만 도는 시연용 좌표 발생기.
 *
 * **무엇이 아닌지 먼저.** 이건 위치추적이 아니다. 진짜 파이프라인은
 * 비콘 신호 → RSSI 비교 → 히스테리시스 → 존 판정인데, 여기서는 **미리 정해둔 동선을
 * 따라 걷는 좌표를 그냥 만들어 낸다**. 방 판정도 '가장 가까운 존 중심'으로 때운다.
 * 그래서 채터링 억제·신호 세기 같은 실제 품질은 이걸로 검증할 수 없다.
 *
 * **왜 두는가.** GitHub Pages 같은 정적 호스팅은 서버를 못 돌린다. 화면만 올리면
 * 도면은 뜨는데 사람이 하나도 없어 무엇을 만든 건지 보여줄 수가 없다. 동선 데이터는
 * 목 게이트웨이와 같은 것(`mock-tags.ts`)을 쓰므로 최소한 **같은 사람들이 같은 길로**
 * 다닌다.
 *
 * ⚠️ 화면에는 반드시 '시연용 가상 데이터' 표시를 띄운다 — 겉보기가 진짜와 거의
 *    같아서, 표시가 없으면 보는 사람이 추적 정확도로 오해한다.
 */

/** 존 중심에서 이 거리(도면 px) 밖이면 '복도 이동 중'으로 본다 */
const TRANSIT_RADIUS_PX = 95;

export class DemoSim {
  private timelines: Map<string, RouteTimeline>;
  private centers: Array<{ zoneId: string; x: number; y: number }>;
  /** 시나리오 시작 시각 — 화면을 연 순간부터 흐른다 */
  private readonly startedAt: number;
  private readonly speed: number;

  constructor(zones: Zone[], opts: { speed?: number; now?: number } = {}) {
    this.speed = opts.speed ?? 1;
    this.startedAt = opts.now ?? Date.now();
    this.centers = zones.map((z) => ({ zoneId: z.zoneId, x: z.tilePosition.x, y: z.tilePosition.y }));
    this.timelines = buildRouteTimelines(
      ROUTES,
      new Map(zones.map((z) => [z.zoneId, z.tilePosition])),
    );
  }

  /** 목 게이트웨이가 시드하는 것과 같은 이름·그룹 */
  tagMeta(): TagMetaMap {
    const map: TagMetaMap = {};
    MOCK_TAGS.forEach((tag, i) => {
      const p = mockProfileFor(tag.mac, tag.route, i);
      map[tag.mac] = { name: p.name, memo: p.memo, group: p.group };
    });
    return map;
  }

  /** 지금 이 순간 전원의 좌표 — 서버의 `pos:update` 페이로드와 같은 모양 */
  positions(now: number = Date.now()): PositionEstimate[] {
    const elapsed = ((now - this.startedAt) / 1000) * this.speed;
    const out: PositionEstimate[] = [];
    for (const tag of MOCK_TAGS) {
      const tl = this.timelines.get(tag.route);
      if (!tl) continue;
      const p = positionAt(tl, elapsed + tag.offsetSec);
      const near = this.nearestZone(p.x, p.y);
      // 걷는 중이고 어느 방 중심에서도 멀면 복도로 본다 — 지나치는 방 이름을
      // 현황에 찍으면 목록이 계속 바뀌어 읽을 수가 없다 (서버도 같은 판단을 한다)
      const inTransit = p.moving && near.dist > TRANSIT_RADIUS_PX;
      out.push({ tagId: tag.mac, x: p.x, y: p.y, zone: near.zoneId, inTransit });
    }
    return out;
  }

  /** 시연용 환자 화면이 따라갈 비콘 (서버의 SERVER_CONFIG.demoPatientTag 와 같은 값) */
  get demoPatientTag(): string {
    return MOCK_TAGS[0].mac;
  }

  private nearestZone(x: number, y: number): { zoneId: string; dist: number } {
    let best = this.centers[0];
    let bestD = Infinity;
    for (const c of this.centers) {
      const d = Math.hypot(c.x - x, c.y - y);
      if (d < bestD) {
        bestD = d;
        best = c;
      }
    }
    return { zoneId: best.zoneId, dist: bestD };
  }
}
