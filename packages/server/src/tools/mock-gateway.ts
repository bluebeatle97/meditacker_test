/**
 * 목 게이트웨이 — 좌표 기반 이동 시뮬레이션 (트래킹 품질 검증용)
 *
 * 가상 태그가 맵(타일 좌표)을 실제로 "걸어서" 이동한다:
 *   waypoint 경로를 일정 속도로 걸으며, 매 스캔 주기마다
 *   각 게이트웨이까지의 거리 → 경로손실 모델로 RSSI 계산 → publish.
 *
 * 서버의 RSSI 가중평균(pos:update)이 이 실제 경로를 잘 따라오는지,
 * 존 판정(presence:update)이 경계에서 안정적인지 눈으로 확인하는 용도.
 *
 *   npm run mock:gw -w @meditracker/server
 *   MOCK_SPEED=4 npm run mock:gw ...   # 4배속
 *   SCAN_INTERVAL_MS=500 (기본)        # 게이트웨이 업로드 주기
 */
import mqtt from 'mqtt';
import { loadGateways, loadZones } from '../config/index.js';
import { WalkableMap } from '../presence/walkable-map.js';
import { MOCK_TAGS, ROUTES } from './mock-tags.js';

const MQTT_URL = process.env.MQTT_URL ?? 'mqtt://localhost:1883';
const SPEED = Number(process.env.MOCK_SPEED ?? 1);
const SCAN_INTERVAL_MS = Number(process.env.SCAN_INTERVAL_MS ?? 500);
// 좌표계 = 도면 이미지 픽셀. 도면 폭 1650px ≈ 26700mm → 1px ≈ 1.62cm
const CM_PER_PX = 1.62;
const WALK_SPEED = 140 / CM_PER_PX; // px/초 (성인 보행 ≈ 1.4m/s)

const client = mqtt.connect(MQTT_URL);
const gateways = loadGateways().filter((g) => g.tile);
const zoneCenter = new Map(loadZones().map((z) => [z.zoneId, z.tilePosition]));

// ── 경로: 존 중심(cm)을 지나는 환자 동선 + 도착 후 머무는 시간(초) ───────────
interface Waypoint {
  x: number;
  y: number;
  pause: number;
}

// 경로를 시간축으로 펼치기: 각 구간 (걷기 or 정지) 의 시작시각 테이블
interface Segment {
  from: Waypoint;
  to: Waypoint;
  startSec: number;
  durationSec: number;
  moving: boolean;
}

function buildTimeline(route: Waypoint[]): { segments: Segment[]; totalSec: number } {
  const segments: Segment[] = [];
  let t = 0;
  for (let i = 0; i < route.length; i++) {
    const cur = route[i];
    const next = route[(i + 1) % route.length];
    segments.push({ from: cur, to: cur, startSec: t, durationSec: cur.pause, moving: false });
    t += cur.pause;
    const dist = Math.hypot(next.x - cur.x, next.y - cur.y);
    const walkSec = dist / WALK_SPEED;
    segments.push({ from: cur, to: next, startSec: t, durationSec: walkSec, moving: true });
    t += walkSec;
  }
  return { segments, totalSec: t };
}

/** 역할별 타임라인은 한 번만 만들어 여러 태그가 오프셋만 달리 해서 공유한다 */
const TIMELINES = new Map<string, { segments: Segment[]; totalSec: number; first: Waypoint }>();
for (const [name, zones] of Object.entries(ROUTES)) {
  const route: Waypoint[] = zones.map(({ zoneId, pause }) => {
    const c = zoneCenter.get(zoneId);
    if (!c) throw new Error(`목 경로에 없는 존: ${zoneId}`);
    return { x: c.x, y: c.y, pause };
  });
  TIMELINES.set(name, { ...buildTimeline(route), first: route[0] });
}

/** 시나리오 시각 → 현재 좌표 */
function positionAt(routeName: string, sec: number): { x: number; y: number } {
  const tl = TIMELINES.get(routeName)!;
  const t = ((sec % tl.totalSec) + tl.totalSec) % tl.totalSec;
  for (const seg of tl.segments) {
    if (t >= seg.startSec && t < seg.startSec + seg.durationSec) {
      if (!seg.moving) return { x: seg.from.x, y: seg.from.y };
      const p = (t - seg.startSec) / seg.durationSec;
      return {
        x: seg.from.x + (seg.to.x - seg.from.x) * p,
        y: seg.from.y + (seg.to.y - seg.from.y) * p,
      };
    }
  }
  return { x: tl.first.x, y: tl.first.y };
}

// ── 경로손실 모델: 거리(cm) + 벽 관통 감쇠 → RSSI ───────────────────────────
const TX_AT_1M = -45; // 1m 에서의 수신세기
const PATH_LOSS_N = 2.2; // 실내 감쇠 지수
const RX_FLOOR = -92; // 이보다 약하면 게이트웨이가 못 들음
/**
 * 벽 1개 관통당 감쇠(dB). 실내 경량 칸막이·석고보드 기준 6~8dB.
 * ⚠️ 이 항이 없으면 옆방 게이트웨이가 실제보다 훨씬 세게 잡혀
 *    위치 추정이 벽 사이에 생기고 방↔방 순간이동처럼 보인다.
 */
const WALL_LOSS_DB = Number(process.env.WALL_LOSS_DB ?? 7);

const walkable = new WalkableMap();

function rssiFor(distPx: number, walls: number): number | null {
  const meters = Math.max((distPx * CM_PER_PX) / 100, 0.3); // px → cm → m
  const rssi =
    TX_AT_1M -
    10 * PATH_LOSS_N * Math.log10(meters) -
    WALL_LOSS_DB * walls +
    (Math.random() - 0.5) * 4;
  return rssi < RX_FLOOR ? null : Math.round(rssi);
}

client.on('connect', () => {
  const laps = [...TIMELINES.entries()]
    .map(([n, tl]) => `${n} ${Math.round(tl.totalSec / SPEED)}s`)
    .join(', ');
  console.log(
    `[mock-gw] connected: ${MQTT_URL} — 태그 ${MOCK_TAGS.length}개 보행 시뮬레이션 (스캔 ${SCAN_INTERVAL_MS}ms)`,
  );
  console.log(`[mock-gw] 경로 한 바퀴: ${laps}`);
  let elapsed = 0;

  setInterval(() => {
    elapsed += (SCAN_INTERVAL_MS / 1000) * SPEED;
    // 게이트웨이별로 이번 주기에 들린 비콘을 모아 한 번에 올린다
    // (태그마다 따로 publish 하면 태그수 x 게이트웨이수 만큼 메시지가 터진다.
    //  실제 게이트웨이도 스캔 결과를 배열로 한 번에 업로드한다)
    const batch = new Map<string, Array<{ mac: string; rssi: number; ts: number }>>();
    const ts = Date.now();
    for (const tag of MOCK_TAGS) {
      const pos = positionAt(tag.route, elapsed + tag.offsetSec);
      for (const gw of gateways) {
        const dist = Math.hypot(gw.tile!.x - pos.x, gw.tile!.y - pos.y);
        // 태그↔게이트웨이 사이의 벽을 세어 관통 감쇠 반영 (현실적 신호)
        const walls = walkable.wallsBetween(pos.x, pos.y, gw.tile!.x, gw.tile!.y);
        const rssi = rssiFor(dist, walls);
        if (rssi === null) continue;
        const list = batch.get(gw.gatewayId) ?? [];
        list.push({ mac: tag.mac, rssi, ts });
        batch.set(gw.gatewayId, list);
      }
    }
    for (const [gatewayId, readings] of batch) {
      client.publish(`gw/${gatewayId}/scan`, JSON.stringify(readings));
    }
  }, SCAN_INTERVAL_MS);
});
