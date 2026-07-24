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

const MQTT_URL = process.env.MQTT_URL ?? 'mqtt://localhost:1883';
const SPEED = Number(process.env.MOCK_SPEED ?? 1);
const SCAN_INTERVAL_MS = Number(process.env.SCAN_INTERVAL_MS ?? 500);
const WALK_SPEED = 140; // cm/초 (성인 보행 ≈ 1.4m/s, 좌표는 cm)

const client = mqtt.connect(MQTT_URL);
const gateways = loadGateways().filter((g) => g.tile);
const zoneCenter = new Map(loadZones().map((z) => [z.zoneId, z.tilePosition]));

// ── 경로: 존 중심(cm)을 지나는 환자 동선 + 도착 후 머무는 시간(초) ───────────
interface Waypoint {
  x: number;
  y: number;
  pause: number;
}

// 도면 구역을 순서대로 경유 (존 중심 좌표 자동 사용)
const ROUTE_ZONES: Array<{ zoneId: string; pause: number }> = [
  { zoneId: 'reception', pause: 40 }, // 접수·중앙 대기
  { zoneId: 'consult_2', pause: 30 }, // 상담실 2
  { zoneId: 'consult_1', pause: 25 }, // 상담실 1
  { zoneId: 'proc_2', pause: 45 }, // 시술실 2
  { zoneId: 'surgery_1', pause: 40 }, // 수술실 1
  { zoneId: 'vip_recovery', pause: 35 }, // VIP 회복실
  { zoneId: 'waiting_2', pause: 20 }, // 대기공간
];

const ROUTE: Waypoint[] = ROUTE_ZONES.map(({ zoneId, pause }) => {
  const c = zoneCenter.get(zoneId) ?? { x: 2500, y: 2000 };
  return { x: c.x, y: c.y, pause };
});

const TAGS = [
  { mac: 'AA:BB:CC:00:00:01', routeOffsetSec: 0 },
  { mac: 'AA:BB:CC:00:00:02', routeOffsetSec: 150 },
];

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

const { segments, totalSec } = buildTimeline(ROUTE);

/** 시나리오 시각 → 현재 좌표 */
function positionAt(sec: number): { x: number; y: number } {
  const t = sec % totalSec;
  for (const seg of segments) {
    if (t >= seg.startSec && t < seg.startSec + seg.durationSec) {
      if (!seg.moving) return { x: seg.from.x, y: seg.from.y };
      const p = (t - seg.startSec) / seg.durationSec;
      return {
        x: seg.from.x + (seg.to.x - seg.from.x) * p,
        y: seg.from.y + (seg.to.y - seg.from.y) * p,
      };
    }
  }
  return { x: ROUTE[0].x, y: ROUTE[0].y };
}

// ── 경로손실 모델: 거리(cm) → RSSI ──────────────────────────────────────────
const TX_AT_1M = -45; // 1m 에서의 수신세기
const PATH_LOSS_N = 2.2; // 실내 감쇠 지수
const RX_FLOOR = -92; // 이보다 약하면 게이트웨이가 못 들음

function rssiFor(distCm: number): number | null {
  const meters = Math.max(distCm / 100, 0.3); // cm → m
  const rssi = TX_AT_1M - 10 * PATH_LOSS_N * Math.log10(meters) + (Math.random() - 0.5) * 4;
  return rssi < RX_FLOOR ? null : Math.round(rssi);
}

client.on('connect', () => {
  console.log(
    `[mock-gw] connected: ${MQTT_URL} — 보행 시뮬레이션 (경로 ${Math.round(totalSec / SPEED)}초/바퀴, 스캔 ${SCAN_INTERVAL_MS}ms)`,
  );
  let elapsed = 0;

  setInterval(() => {
    elapsed += (SCAN_INTERVAL_MS / 1000) * SPEED;
    for (const tag of TAGS) {
      const pos = positionAt(elapsed + tag.routeOffsetSec);
      for (const gw of gateways) {
        const dist = Math.hypot(gw.tile!.x - pos.x, gw.tile!.y - pos.y);
        const rssi = rssiFor(dist);
        if (rssi === null) continue;
        client.publish(
          `gw/${gw.gatewayId}/scan`,
          JSON.stringify([{ mac: tag.mac, rssi, ts: Date.now() }]),
        );
      }
    }
  }, SCAN_INTERVAL_MS);
});
