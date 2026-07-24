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
import { loadGateways } from '../config/index.js';

const MQTT_URL = process.env.MQTT_URL ?? 'mqtt://localhost:1883';
const SPEED = Number(process.env.MOCK_SPEED ?? 1);
const SCAN_INTERVAL_MS = Number(process.env.SCAN_INTERVAL_MS ?? 500);
const WALK_SPEED = 1.4; // 타일/초 (성인 보행 ≈ 1.4m/s, 1타일≈1m 가정)

const client = mqtt.connect(MQTT_URL);
const gateways = loadGateways().filter((g) => g.tile);

// ── 경로: {x, y} waypoint + 도착 후 머무는 시간(초) ─────────────────────────
interface Waypoint {
  x: number;
  y: number;
  pause: number;
}

const ROUTE: Waypoint[] = [
  { x: 4, y: 3, pause: 15 }, // 접수
  { x: 10, y: 8, pause: 60 }, // 대기실 (좌측)
  { x: 12, y: 9, pause: 30 }, // 대기실 안에서 자리 이동 ← 같은 존 내 움직임 확인
  { x: 18, y: 4, pause: 45 }, // 상담실1
  { x: 26, y: 10, pause: 45 }, // 시술실1
  { x: 26, y: 16, pause: 30 }, // 회복실1
  { x: 10, y: 8, pause: 20 }, // 대기실 복귀
];

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

// ── 경로손실 모델: 거리(타일≈m) → RSSI ──────────────────────────────────────
const TX_AT_1M = -45; // 1m 에서의 수신세기
const PATH_LOSS_N = 2.2; // 실내 감쇠 지수
const RX_FLOOR = -92; // 이보다 약하면 게이트웨이가 못 들음

function rssiFor(dist: number): number | null {
  const d = Math.max(dist, 0.3);
  const rssi = TX_AT_1M - 10 * PATH_LOSS_N * Math.log10(d) + (Math.random() - 0.5) * 4;
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
