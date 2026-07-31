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
 *   MOCK_NOISE_MACS=40 ...             # 지나가는 남의 단말 40대 섞기 (아래 노이즈 모드)
 */
import mqtt from 'mqtt';
import { loadFloorplan, loadGateways, loadZones } from '../config/index.js';
import { WalkableMap } from '../presence/walkable-map.js';
import { MOCK_TAGS, ROUTES } from './mock-tags.js';

const MQTT_URL = process.env.MQTT_URL ?? 'mqtt://localhost:1883';
const SPEED = Number(process.env.MOCK_SPEED ?? 1);
const SCAN_INTERVAL_MS = Number(process.env.SCAN_INTERVAL_MS ?? 500);
// 좌표계 = 도면 이미지 픽셀. 도면 폭 1650px ≈ 26700mm → 1px ≈ 1.62cm
const CM_PER_PX = 1.62;
const WALK_SPEED = 140 / CM_PER_PX; // px/초 (성인 보행 ≈ 1.4m/s)

/**
 * 부하 시험용 태그 증식 — `MOCK_TAGS_N=100` 이면 명단을 그 수까지 채운다.
 * 기존 동선을 돌려쓰고 오프셋만 흩어 놓는다 (이름·그룹은 없으니 시험용으로만).
 */
const WANT_TAGS = Number(process.env.MOCK_TAGS_N ?? 0);
const TAGS = [...MOCK_TAGS];
if (WANT_TAGS > TAGS.length) {
  const routes = Object.keys(ROUTES);
  for (let i = TAGS.length; i < WANT_TAGS; i++) {
    TAGS.push({
      mac: `AA:BB:CC:FF:${String(Math.floor(i / 256)).padStart(2, '0')}:${(i % 256).toString(16).padStart(2, '0').toUpperCase()}`,
      route: routes[i % routes.length],
      offsetSec: (i * 37) % 200,
    });
  }
  console.log(`[mock-gw] 부하시험: 태그 ${TAGS.length}개로 증식`);
}

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

// ── 노이즈 모드: 등록 안 된 남의 단말 ───────────────────────────────────────
/**
 * 실제 병원 복도에는 우리 비콘 말고도 BLE 광고를 뿌리는 물건이 널려 있다 —
 * 환자·보호자 폰, 이어버드, 스마트워치, 옆 층 사람. 게다가 iOS/Android 는
 * 프라이버시 때문에 **MAC 을 15분마다 무작위로 바꾼다**. 폰 한 대가 하루에 서로 다른
 * 식별자를 100개 가까이 만든다는 뜻이다.
 *
 * 기본 목 게이트웨이는 우리가 시드한 태그만 쏘기 때문에 이 상황이 **로컬에서 재현되지
 * 않는다**. 그래서 장비 붙이는 날 처음 겪게 되고, 그날은 다른 것도 같이 터진다.
 * 이 모드로 오늘 재현해서 화이트리스트가 실제로 막는지 확인한다.
 *
 *   MOCK_NOISE_MACS=40 MOCK_SPEED=60 npm run mock:gw -w @meditracker/server
 *   → 40대가 시뮬레이션 15분(실시간 15초)마다 새 MAC 으로 갈아탄다
 */
const NOISE_MACS = Number(process.env.MOCK_NOISE_MACS ?? 0);
/**
 * 노이즈만 쏘고 우리 태그는 쏘지 않는다. 이미 돌고 있는 스택을 건드리지 않고
 * "로비에 사람이 몰린 상황" 만 겹쳐서 던져볼 때 쓴다 (같은 태그를 두 곳에서 쏘면
 * 위치가 싸워서 데모가 이상해진다).
 */
const NOISE_ONLY = process.env.MOCK_NOISE_ONLY === '1';
/** MAC 교체 주기(시뮬레이션 초). iOS/Android 기본값이 대략 15분 */
const NOISE_ROTATE_SEC = Number(process.env.MOCK_NOISE_ROTATE_SEC ?? 900);
/** 주머니·가방 속 단말의 인체 감쇠 — 우리 비콘(옷 밖 목걸이)보다 확실히 약하게 잡힌다 */
const NOISE_BODY_LOSS_DB = 12;

const floorplan = loadFloorplan();

interface NoiseDevice {
  mac: string;
  x: number;
  y: number;
  rotateAtSec: number;
}

/** 지역관리(locally administered) 비트를 세운 무작위 MAC — 실제 폰이 쓰는 방식 그대로 */
function randomPrivateMac(): string {
  const bytes = Array.from({ length: 6 }, () => Math.floor(Math.random() * 256));
  bytes[0] = (bytes[0] | 0x02) & 0xfe; // LA 비트 on, 멀티캐스트 비트 off
  return bytes.map((b) => b.toString(16).padStart(2, '0').toUpperCase()).join(':');
}

/** 도면 안 아무 곳 — 벽 안이면 clamp 가 통행 가능한 자리로 밀어낸다 */
function randomSpot(): { x: number; y: number } {
  return walkable.clamp(Math.random() * floorplan.width, Math.random() * floorplan.height);
}

function newNoiseDevice(nowSec: number): NoiseDevice {
  const spot = randomSpot();
  return {
    mac: randomPrivateMac(),
    x: spot.x,
    y: spot.y,
    // 전원이 동시에 갈아타면 부하가 톱니처럼 튄다 — 교체 시점을 흩어 놓는다
    rotateAtSec: nowSec + NOISE_ROTATE_SEC * (0.5 + Math.random()),
    };
}

const noiseDevices: NoiseDevice[] = [];

function rssiFor(distPx: number, walls: number, extraLossDb = 0): number | null {
  const meters = Math.max((distPx * CM_PER_PX) / 100, 0.3); // px → cm → m
  const rssi =
    TX_AT_1M -
    10 * PATH_LOSS_N * Math.log10(meters) -
    WALL_LOSS_DB * walls -
    extraLossDb +
    (Math.random() - 0.5) * 4;
  return rssi < RX_FLOOR ? null : Math.round(rssi);
}

client.on('connect', () => {
  const laps = [...TIMELINES.entries()]
    .map(([n, tl]) => `${n} ${Math.round(tl.totalSec / SPEED)}s`)
    .join(', ');
  console.log(
    `[mock-gw] connected: ${MQTT_URL} — ` +
      (NOISE_ONLY
        ? `노이즈 전용 (우리 태그는 안 쏨)`
        : `태그 ${TAGS.length}개 보행 시뮬레이션`) +
      ` (스캔 ${SCAN_INTERVAL_MS}ms)`,
  );
  if (!NOISE_ONLY) console.log(`[mock-gw] 경로 한 바퀴: ${laps}`);
  for (let i = 0; i < NOISE_MACS; i++) noiseDevices.push(newNoiseDevice(0));
  if (NOISE_MACS > 0) {
    console.log(
      `[mock-gw] 노이즈 ${NOISE_MACS}대 — 등록 안 된 남의 단말, 시뮬 ${NOISE_ROTATE_SEC}초마다 MAC 교체`,
    );
  }
  let elapsed = 0;

  setInterval(() => {
    elapsed += (SCAN_INTERVAL_MS / 1000) * SPEED;
    // 게이트웨이별로 이번 주기에 들린 비콘을 모아 한 번에 올린다
    // (태그마다 따로 publish 하면 태그수 x 게이트웨이수 만큼 메시지가 터진다.
    //  실제 게이트웨이도 스캔 결과를 배열로 한 번에 업로드한다)
    const batch = new Map<string, Array<{ mac: string; rssi: number; ts: number }>>();
    const ts = Date.now();
    for (const tag of NOISE_ONLY ? [] : TAGS) {
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
    // 등록 안 된 남의 단말 — 게이트웨이는 이것도 가리지 않고 올린다.
    // 서버 화이트리스트가 없으면 이 MAC 들이 그대로 존 판정·좌표·화면까지 흘러간다.
    for (const dev of noiseDevices) {
      if (elapsed >= dev.rotateAtSec) Object.assign(dev, newNoiseDevice(elapsed)); // MAC 교체
      for (const gw of gateways) {
        const dist = Math.hypot(gw.tile!.x - dev.x, gw.tile!.y - dev.y);
        const walls = walkable.wallsBetween(dev.x, dev.y, gw.tile!.x, gw.tile!.y);
        const rssi = rssiFor(dist, walls, NOISE_BODY_LOSS_DB);
        if (rssi === null) continue;
        const list = batch.get(gw.gatewayId) ?? [];
        list.push({ mac: dev.mac, rssi, ts });
        batch.set(gw.gatewayId, list);
      }
    }

    for (const [gatewayId, readings] of batch) {
      client.publish(`gw/${gatewayId}/scan`, JSON.stringify(readings));
    }
  }, SCAN_INTERVAL_MS);
});
