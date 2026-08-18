import { createServer, type IncomingMessage } from 'node:http';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  buildGatewayZoneMap,
  loadFloorplan,
  loadGateways,
  loadRealGateways,
  loadZones,
  saveGateways,
  SERVER_CONFIG,
  ZONE_ENGINE_CONFIG,
} from './config/index.js';
import { ZoneEngine } from './zone-engine/zone-engine.js';
import { MqttIngestion } from './ingestion/mqtt-ingestion.js';
import { AutoAdapter } from './ingestion/adapters/auto.adapter.js';
import { PresenceService } from './presence/presence-service.js';
import { PositionEstimator } from './presence/position-estimator.js';
import { ScanRateMeter, smoothingFor } from './presence/scan-rate.js';
import { WalkableMap } from './presence/walkable-map.js';
import {
  assignBeacon,
  claimAssignment,
  countOpenFeedback,
  deleteFeedback,
  findBeacon,
  insertFeedback,
  listFeedback,
  setFeedbackStatus,
  findBeaconByPin,
  getOpenAssignment,
  isClaimed,
  listBeacons,
  pinOf,
  resetClaim,
  getPatientProfile,
  openDb,
  registerBeacon,
  releaseBeacon,
  renameHolder,
  retireBeacon,
  upsertPatientProfile,
} from './db/index.js';
import { createWsServer } from './ws/index.js';
import { signToken, verifyToken } from './auth/jwt.js';
import { FAIL_DELAY_MS, PinGate } from './auth/staff-pin.js';
import { MonitorHub } from './monitor/monitor-hub.js';
import { monitorPageHtml } from './monitor/monitor-page.js';
import { createStaticHandler } from './web/static-files.js';
import { TagMetaStore } from './presence/tag-meta-store.js';
import { KnownTagStore } from './presence/known-tag-store.js';
import { AssignedTagStore } from './presence/assigned-tag-store.js';
import { IdleBeaconStore } from './presence/idle-beacon-store.js';
import { GuidanceStore } from './presence/guidance-store.js';
import { NavigationLogStore } from './presence/navigation-log.js';
import {
  announceToManager,
  channelTalkConfigured,
  escapeMarkup,
  listGroups,
  listManagers,
  mentionMarkup,
  sendGroupMessage,
  type ChannelTalkResult,
} from './notifications/channel-talk/client.js';
import { channelTalkTestPageHtml } from './notifications/channel-talk/test-page.js';
import { UnknownTagBuffer } from './ingestion/unknown-tag-buffer.js';
import { ScanRouter } from './ingestion/scan-router.js';
import { ScanRecorder } from './recording/scan-recorder.js';
import {
  isGuidableZone,
  isValidCharId,
  MOCK_TAGS,
  TAG_GROUP_IDS,
  ZoneDwellFilter,
  ZONE_DWELL_MS,
  type FeedbackKind,
  type Gateway,
  type TagGroup,
} from '@meditracker/shared';

// ── 조립: Ingestion → Zone Engine → Presence/DB → Permission → WS ──────────

const configDir = join(dirname(fileURLToPath(import.meta.url)), 'config');

/**
 * 빌드된 화면 서빙 (배포용). 화면을 안 빌드했으면 조용히 넘어간다 — 개발 중에는
 * Vite 개발 서버가 화면을 맡고 여기는 API 만 준다.
 */
const packagesDir = join(dirname(fileURLToPath(import.meta.url)), '../..');
const serveStatic = createStaticHandler([
  { prefix: '/patient/', dir: join(packagesDir, 'web-patient/dist') },
  { prefix: '/', dir: join(packagesDir, 'web-staff/dist') },
]);

const db = openDb(SERVER_CONFIG.dbPath);

let gateways = loadGateways();
/**
 * 실장비 게이트웨이 id — 나머지는 계획 배치(테스트용)다.
 *
 * 두 목록이 서로 겹치지 않는 별개라(계획 50대에 실장비 2대가 없다) 이렇게 따로 읽는다.
 */
let REAL_GATEWAYS = new Set(loadRealGateways().map((g) => g.gatewayId));
/**
 * 목업 비콘 판정 — **시드 MAC 접두사**로 본다.
 *
 * 처음엔 `MOCK_TAGS`(시뮬레이터가 실제로 쏘는 16개)로 했는데, 시드로만 넣어 둔
 * 나머지 7개가 안 걸려서 껐는데도 등록/반납 목록에 가짜가 남았다. 스캔에는 안 나와도
 * **목록에는 있는** 가짜가 있다. 접두사 하나로 23개가 다 잡힌다.
 */
const MOCK_MAC_PREFIX = 'AA:BB:CC:';
const isTestGateway = (id: string): boolean => !REAL_GATEWAYS.has(id);
const isTestTag = (id: string): boolean => id.startsWith(MOCK_MAC_PREFIX);
// 시뮬레이터가 쏘는 것들이 그 접두사를 벗어나면 위 판정이 조용히 새므로 부팅 때 짚는다
{
  const stray = MOCK_TAGS.filter((t) => !isTestTag(t.mac));
  if (stray.length > 0) {
    console.warn(
      `[server] ⚠️ 목업 태그 ${stray.length}개가 ${MOCK_MAC_PREFIX} 접두사를 안 쓴다`
        + ` — 테스트 장비를 꺼도 안 빠진다: ${stray.map((t) => t.mac).join(', ')}`,
    );
  }
}
/** 게이트웨이→존 매핑. 현장 등록 시 이 변수를 갈아치우고 엔진에도 밀어 넣는다 */
let gatewayZoneMap = buildGatewayZoneMap(gateways);
const engine = new ZoneEngine(gatewayZoneMap, ZONE_ENGINE_CONFIG);

const presence = new PresenceService(engine, db);
const estimator = new PositionEstimator(
  gateways,
  engine,
  ZONE_ENGINE_CONFIG.POS_WEIGHT_DIV,
  ZONE_ENGINE_CONFIG.POS_MODE,
);
const tagMeta = new TagMetaStore(db);
// 도면 벽 정보 — 운영 화면 좌표를 벽 안쪽으로 보정 (관제는 raw 유지)
const walkable = new WalkableMap();

// 모니터 허브는 io 생성 후 초기화 (아래) — 참조만 먼저 선언
let monitor: MonitorHub | undefined;

/**
 * 수신값은 들어오는 대로 쌓고, **존 판정은 주기로 묶어서** 돌린다.
 * 게이트웨이 50대 × 태그 수십 개면 초당 1,000건이 넘게 들어오는데 건마다 판정하면
 * 서버가 CPU 한 코어를 다 쓰고 HTTP 응답조차 못 한다(실측). 묶으면 부하가 태그 수에만
 * 비례하고, CONFIRM_COUNT 도 설계 의도대로 '스캔 주기 N회' 가 된다.
 */
const dirtyTags = new Set<string>();

// 등록 태그 화이트리스트 + 미등록 신호 임시 보관함 (관제 "미등록 신호" 패널의 원천)
const knownTags = new KnownTagStore(db);
const unknownTags = new UnknownTagBuffer();
/**
 * 배정 여부 — 화면에 나갈 대상의 기준. 등록(화이트리스트)과 별개다.
 * 창고 비콘도 전원이 켜져 있어 신호를 보내지만 사람이 아니므로 화면엔 안 나온다.
 */
const assignedTags = new AssignedTagStore(db);
/** 미배정 비콘의 마지막 신호만 — 배터리 죽은 비콘·소재 확인용 (판정에는 안 태운다) */
const idleBeacons = new IdleBeaconStore();
/** 진행 중인 방 안내 (직원이 걸고, 도착하면 서버가 자동으로 푼다) */
const guidance = new GuidanceStore();
/**
 * 안내 **이력** (DB). 위의 `guidance` 는 화면에 뜨는 살아 있는 화살표고, 이쪽은
 * "무슨 지시를 내렸고 어떻게 끝났나" 다 — 알림톡이 붙는 자리라 재시작을 넘어 남아야 한다.
 */
const navLog = new NavigationLogStore(db);
/**
 * 재시작으로 화살표를 잃은 안내들을 끊는다.
 * 안 끊으면 아무도 도착 판정을 못 해 주는 줄이 `moving` 으로 영원히 남는다.
 */
{
  const stale = navLog.reconcileOnBoot();
  if (stale > 0) console.log(`[server] 재시작 전 진행 중이던 방 안내 ${stale}건 정리(aborted)`);
}

/**
 * 손님 통제구역 마스크 — 직원이 도면에 칠해 준 구역.
 * 없으면(아직 안 칠함) 아무 데도 막지 않는다.
 */
const staffArea = (() => {
  try {
    return JSON.parse(readFileSync(join(configDir, 'staff-area.json'), 'utf-8')) as {
      cell: number;
      cols: number;
      rows: number;
      grid: string[];
    };
  } catch {
    return null;
  }
})();

function inStaffArea(p: { x: number; y: number }): boolean {
  if (!staffArea) return false;
  const gx = Math.floor(p.x / staffArea.cell);
  const gy = Math.floor(p.y / staffArea.cell);
  if (gx < 0 || gy < 0 || gx >= staffArea.cols || gy >= staffArea.rows) return false;
  return staffArea.grid[gy].charCodeAt(gx) === 49;
}

// 현장 튜닝용 raw 스캔 녹화 (RECORD_SCANS 가 있을 때만)
const recorder = SERVER_CONFIG.recordScans
  ? new ScanRecorder(SERVER_CONFIG.recordScans, gateways, ZONE_ENGINE_CONFIG)
  : null;

/**
 * 모든 스캔이 지나는 단일 관문. 등록 태그만 아래로 내려보낸다.
 * 미등록(지나가는 폰·이어버드·워치, 15분마다 바뀌는 랜덤 MAC)은 여기서 끝 —
 * 판정·좌표·로그·관제 피드 어디에도 안 들어가고 등록 화면에만 잠깐 뜬다.
 */
/** 태그마다 평활 세기를 다르게 주려고 수신 빈도를 잰다 (느린 비콘만 세게 누른다) */
const scanRate = new ScanRateMeter();

const scanRouter = new ScanRouter(
  knownTags,
  unknownTags,
  (scan) => {
    engine.ingest(scan, false);
    dirtyTags.add(scan.tagId);
    scanRate.record(scan.tagId); // 평활 세기를 이 태그의 수신 빈도로 고른다
    monitor?.recordScan(scan); // 관제 피드로 raw 스캔 탭
    recorder?.record(scan); // 녹화 중이면 원본 그대로 적재
  },
  SERVER_CONFIG.tagWhitelist,
  (gatewayId) => gatewayZoneMap.has(gatewayId),
  (tagId) => assignedTags.has(tagId),
  idleBeacons,
  isTestGateway,
  isTestTag,
);

const ingestion = new MqttIngestion(
  SERVER_CONFIG.mqttUrl,
  SERVER_CONFIG.mqttScanTopics,
  new AutoAdapter({ reverseMac: SERVER_CONFIG.abMacReverse }),
  (scan) => scanRouter.route(scan),
);
ingestion.start();

setInterval(() => {
  if (dirtyTags.size === 0) return;
  for (const tagId of dirtyTags) engine.evaluate(tagId);
  dirtyTags.clear();
}, SERVER_CONFIG.zoneEvalIntervalMs);

// 존 전환을 관제 로그로 탭
presence.onChange((c) =>
  monitor?.recordZoneChange({ tagId: c.tagId, fromZone: c.fromZone, toZone: c.toZone, at: c.at }),
);

/**
 * 화이트리스트 주기 재적재.
 *
 * 등록 API 는 즉시 reload 하지만, **앱 밖에서 DB 가 바뀌는 경우**가 있다 —
 * `npm run dev:seed`, 수동 SQL, 앞으로 붙일 태그 지급/반납 도구. 그때 캐시가 낡은 채로
 * 남으면 방금 배정한 비콘이 계속 차단되고, 원인을 찾느라 시간을 버린다(실제로 겪음).
 * 작은 인덱스 테이블 한 번 읽는 것이라 비용은 사실상 0.
 */
setInterval(() => {
  const before = knownTags.size();
  knownTags.reload();
  const after = knownTags.size();
  if (before !== after) console.log(`[server] 화이트리스트 갱신: ${before} → ${after}개`);
  const beforeA = assignedTags.size();
  assignedTags.reload();
  if (beforeA !== assignedTags.size()) {
    console.log(`[server] 배정 갱신: ${beforeA} → ${assignedTags.size()}개`);
  }
}, 30_000);

// 자리비움 스윕 (ABSENT_TIMEOUT) + 오래 조용한 태그 메모리 정리 (EVICT_AFTER_MS)
setInterval(() => {
  const evicted = engine.sweepAbsent();
  if (evicted > 0) {
    const mins = Math.round(ZONE_ENGINE_CONFIG.EVICT_AFTER_MS / 60000);
    console.log(`[server] 태그 상태 정리: ${evicted}건 (${mins}분 이상 무신호)`);
  }
}, SERVER_CONFIG.absentSweepIntervalMs);

/**
 * 개발용 환자 토큰이 가리킬 사람.
 *
 * `?tag=<비콘MAC>` 을 주면 그 비콘을 든 사람으로 발급한다 — 비콘마다 QR 을 붙여
 * "찍으면 그 비콘의 환자 화면" 으로 들어가는 구조를 그대로 흉내낸 것이다.
 * 안 주면 **태그가 실제로 배정된** 첫 환자(손님 1). 고정 id 를 쓰면 시드가 바뀔 때
 * 추적 대상 없는 사람을 가리켜 환자 화면이 딴 세상처럼 보인다(실제로 그렇게 신고됨).
 */
function patientForToken(tagId: string | null): string {
  // ?tag= 우선, 없으면 시연용 고정 비콘(손님 1), 그것도 없으면 아무 환자
  for (const candidate of [tagId, SERVER_CONFIG.demoPatientTag]) {
    if (!candidate) continue;
    const open = getOpenAssignment(db, candidate);
    if (open) return open.personId;
  }
  // 배정된 환자가 하나도 없으면(창고에 다 있는 상태) 마지막 수단
  const row = db
    .prepare(
      `SELECT a.person_id AS personId FROM assignments a JOIN persons p ON p.person_id = a.person_id
       WHERE a.released_at IS NULL AND p.type = 'patient' ORDER BY a.assigned_at DESC LIMIT 1`,
    )
    .get() as { personId: string } | undefined;
  return row?.personId ?? 'patient-001';
}

/**
 * 손으로 친 MAC 을 장비가 보내는 표기로 맞춘다 (`28562f79b420`·`28-56-2F-…` → `28:56:2F:…`).
 *
 * 장비 관리 화면에서는 사람이 스티커를 보고 직접 넣는다. 표기가 한 글자만 달라도
 * `gatewayZoneMap`·화이트리스트가 **조용히** 안 맞아서 "등록했는데 아무 일도 안 일어난다"
 * 가 된다 — 어댑터가 쓰는 것과 같은 규칙으로 여기서 한 번 펴 준다.
 *
 * 12자리 16진수가 아니면 빈 문자열 → 호출부가 거절한다.
 */
function normalizeMac(raw: string): string {
  const hex = (raw ?? '').replace(/[^0-9a-fA-F]/g, '').toUpperCase();
  if (hex.length !== 12) return '';
  return (hex.match(/.{2}/g) as string[]).join(':');
}

/**
 * 게이트웨이 목록 교체 — 파일에 쓰고 **재시작 없이** 관문·판정·좌표추정·관제에 전부 민다.
 *
 * 등록·수정·삭제가 전부 여기를 지난다. 예전엔 등록 한 곳에만 이 다섯 줄이 있었는데,
 * 한 군데라도 빠뜨리면 파일과 돌아가는 목록이 갈라져 화면이 조용히 거짓말을 한다.
 */
function applyGateways(list: Gateway[]): void {
  saveGateways(list);
  // 실장비 파일을 고쳤으면 '실장비' 판정도 같이 갱신 — 테스트 장비 스위치의 기준이다
  REAL_GATEWAYS = new Set(loadRealGateways().map((g) => g.gatewayId));
  // 테스트 장비를 꺼 둔 상태면 올릴 목록은 실장비뿐이다 (켜면 방금 쓴 파일 그대로)
  gateways = scanRouter.isTestGearOn() ? list : loadRealGateways();
  gatewayZoneMap = buildGatewayZoneMap(gateways);
  engine.setGatewayZoneMap(gatewayZoneMap);
  estimator.setGateways(gateways);
  monitor?.setGateways(gateways);
}

const CORS_JSON = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' };

/**
 * 직원 전용 API — staff 토큰(진입 핀으로 받는다) 없이는 401.
 *
 * **왜 목록을 한 곳에 두나.** 엔드포인트마다 검사를 넣으면 새 API 를 추가할 때 빠뜨리고,
 * 빠뜨린 것은 아무 증상이 없다 — 그냥 열려 있다. 한 곳에서 막으면 새 경로는 **기본이 잠긴
 * 쪽**이 되고, 공개해야 하는 것만 여기서 빼면 된다.
 *
 * 공개로 남긴 것과 이유:
 * - `/health` — 헬스체크(Caddy·Render)가 토큰을 들고 다닐 수 없다
 * - `/zones`·`/floorplan`·`/walkable`·`/staff-area`·`/corridor` — 도면 기하. 비밀이 아니고
 *   환자 화면도 쓴다. 게다가 화면은 이걸로 '서버가 살아 있나' 를 판단한다 (demo-mode.ts)
 * - `/patient-token`·`/patient-profile` — 환자 자신의 핀·토큰으로 이미 검사한다
 * - `/monitor` — HTML 은 비밀이 아니다. 데이터는 소켓 토큰이 막는다 (ws/index.ts)
 */
const STAFF_ONLY = [
  '/beacons',
  '/gateways',
  '/tag-meta',
  '/unknown-tags',
  '/unknown-gateways',
  '/register-tag',
  '/register-gateway',
  '/delete-gateway',
  '/register-beacon',
  '/delete-beacon',
  '/assign',
  '/release',
  '/reset-claim',
  '/guide',
  '/nav-logs',
  '/feedback',
  '/test-gear',
  '/record/mark',
];

/** 경로가 직원 전용인지 (쿼리는 떼고 본다) */
function isStaffOnlyPath(url: string): boolean {
  const path = url.split('?')[0];
  return STAFF_ONLY.some((p) => path === p || path.startsWith(`${p}/`));
}

/**
 * `Authorization: Bearer <토큰>` 에서 staff 토큰을 읽는다. `?token=` 도 받는다 — 관제 딥링크와
 * curl 디버깅용이다 (주소창·로그에 남으므로 화면 코드는 헤더 쪽을 쓴다).
 */
function isStaffRequest(req: IncomingMessage): boolean {
  const header = req.headers.authorization ?? '';
  const fromHeader = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
  const fromQuery = new URL(req.url ?? '/', 'http://localhost').searchParams.get('token') ?? '';
  const claims = verifyToken(fromHeader || fromQuery, SERVER_CONFIG.jwtSecret);
  return claims?.type === 'staff';
}

/** 진입 핀으로 내주는 직원 신분 — 개발 토큰과 같은 값이라야 권한 필터 기준이 안 바뀐다 */
const STAFF_CLAIMS = {
  personId: 'staff-doc-1',
  type: 'staff',
  role: 'doctor',
  dept: 'derma',
} as const;

const pinGate = new PinGate(SERVER_CONFIG.staffPin);

/**
 * 핀 잠금을 묶는 기준.
 *
 * 리버스 프록시(Caddy) 뒤에서는 remoteAddress 가 프록시 자신이라 **전원이 한 통에 묶인다** —
 * 한 명이 틀려서 전 직원이 잠기면 시연이 멈춘다. 그래서 프록시가 붙여 주는 X-Forwarded-For
 * 를 먼저 본다. 그 헤더는 위조할 수 있어 잠금 회피가 가능하므로, 실패 지연(FAIL_DELAY_MS)이
 * 따로 있고 근본 대책은 **더 긴 핀**이다.
 */
function clientKey(req: IncomingMessage): string {
  const xff = req.headers['x-forwarded-for'];
  const first = (Array.isArray(xff) ? xff[0] : (xff ?? '')).split(',')[0];
  return first.trim() || req.socket.remoteAddress || 'unknown';
}

/** 본문 수신 + 크기 방어. content-type 을 안 붙여 preflight 없는 simple request 로 받는다. */
function readBody(req: IncomingMessage, limit: number, done: (body: string) => void): void {
  let body = '';
  req.on('data', (c) => {
    body += c;
    if (body.length > limit) req.destroy();
  });
  req.on('end', () => done(body));
}

const httpServer = createServer((req, res) => {
  /**
   * CORS 프리플라이트. 직원 전용 API 는 `Authorization` 헤더를 달고 오는데, 그 헤더가 붙으면
   * 브라우저가 먼저 OPTIONS 를 던진다. 여기서 답하지 않으면 개발(5173→8080)과 화면 별도
   * 배포가 **통째로** 막힌다 — 이 파일 곳곳의 "Content-Type 을 붙이지 마라" 주석이 그 사고의
   * 흔적이다. 이제 핸들러가 있으므로 그 회피는 필수가 아니지만 굳이 되돌릴 이유도 없다.
   */
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'authorization',
      'Access-Control-Max-Age': '86400',
    });
    res.end();
    return;
  }
  // 직원 전용 관문 — 토큰이 없으면 여기서 끝난다 (화면은 pinRequired 를 보고 핀을 묻는다)
  if (isStaffOnlyPath(req.url ?? '') && !isStaffRequest(req)) {
    res.writeHead(401, CORS_JSON);
    res.end(JSON.stringify({ ok: false, error: '직원 인증이 필요합니다', pinRequired: true }));
    return;
  }
  /**
   * 직원용·관제 진입 토큰.
   *
   * - `GET` — 개발 편의. `devTokens` 가 켜져 있을 때만 핀 없이 내준다. 운영에서는
   *   401 `{ pinRequired: true }` 로 답하고, 화면이 그걸 보고 핀 입력을 띄운다.
   * - `POST` — 본문 `{"pin":"..."}`. 맞으면 staff 토큰(12시간).
   */
  if (req.url === '/staff-token' || req.url?.startsWith('/staff-token?')) {
    if (req.method === 'GET') {
      if (!SERVER_CONFIG.devTokens) {
        res.writeHead(401, CORS_JSON);
        res.end(JSON.stringify({ ok: false, pinRequired: true }));
        return;
      }
      res.writeHead(200, CORS_JSON);
      res.end(JSON.stringify({ token: signToken(STAFF_CLAIMS, SERVER_CONFIG.jwtSecret) }));
      return;
    }
    if (req.method === 'POST') {
      readBody(req, 200, (body) => {
        let pin = '';
        try {
          pin = String((JSON.parse(body || '{}') as { pin?: unknown }).pin ?? '');
        } catch {
          pin = '';
        }
        const key = clientKey(req);
        const verdict = pinGate.attempt(key, pin);
        if (verdict === 'ok') {
          res.writeHead(200, CORS_JSON);
          res.end(JSON.stringify({ token: signToken(STAFF_CLAIMS, SERVER_CONFIG.jwtSecret) }));
          return;
        }
        // 실패는 늦게 답한다 — 초당 수백 번 던지는 것을 막는 값싼 한 겹
        setTimeout(() => {
          if (verdict === 'locked') {
            const ms = pinGate.lockedForMs(key);
            res.writeHead(429, CORS_JSON);
            res.end(
              JSON.stringify({
                ok: false,
                error: `시도가 너무 많습니다. ${Math.ceil(ms / 1000)}초 후 다시 하세요`,
                retryAfterMs: ms,
              }),
            );
            return;
          }
          res.writeHead(401, CORS_JSON);
          res.end(JSON.stringify({ ok: false, error: '핀이 맞지 않습니다' }));
        }, FAIL_DELAY_MS);
      });
      return;
    }
  }
  if (req.url === '/health') {
    // ⚠️ CORS 필수: 화면이 서버와 다른 도메인일 때(개발 5173→8080, 프론트만 따로 배포)
    //    이 헤더가 없으면 브라우저가 응답을 막아 **서버가 살아 있는데도 죽은 것으로 보인다**.
    res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end(
      JSON.stringify({ ok: true, tags: engine.getAllStates().length, scans: scanRouter.stats() }),
    );
    return;
  }
  // 도면 배경 이미지 메타 (프론트가 이미지 위에 존/아바타 매핑)
  if (req.url === '/floorplan') {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify(loadFloorplan()));
    return;
  }
  // 직원 전용 구역 마스크 — 안내 경로가 여길 지나지 않게 돌아가는 데 쓴다.
  // 통행 격자와 **따로** 두는 이유: 여기도 사람이 다닐 수는 있다(직원). 통행 격자에
  // 섞으면 직원 좌표가 벽으로 밀려나고, 격자를 읽는 여섯 군데를 다 고쳐야 한다
  if (req.url === '/staff-area') {
    res.writeHead(200, {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
      'Cache-Control': 'no-store',
    });
    res.end(readFileSync(join(configDir, 'staff-area.json'), 'utf-8'));
    return;
  }

  /**
   * 통행 공간(복도·대기공간·홀) 마스크 — 안내 경로가 웬만하면 여기로 다니게 하는 데 쓴다.
   * 여기 없는 칸은 방이고, 목적지가 아닌 방은 지나가면 비싸다 (tools/build-rooms.py).
   */
  if (req.url === '/corridor') {
    res.writeHead(200, {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
      'Cache-Control': 'no-store',
    });
    res.end(readFileSync(join(configDir, 'corridor.json'), 'utf-8'));
    return;
  }

  // 통제구역(벽/샤프트) 그리드 — 프론트의 경로탐색·오버레이 표시용
  // ⚠️ 캐시 금지: 그리드 갱신 후에도 브라우저가 구버전을 쓰면 화면과 서버 판정이 어긋난다
  if (req.url === '/walkable') {
    res.writeHead(200, {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
      'Cache-Control': 'no-store',
    });
    res.end(readFileSync(join(configDir, 'walkable.json'), 'utf-8'));
    return;
  }
  // 존 레이아웃 (프론트 맵 렌더링용 — 위치 정보 아님, 정적 마스터)
  if (req.url === '/zones') {
    res.writeHead(200, {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
    });
    res.end(JSON.stringify(loadZones()));
    return;
  }
  /**
   * 비콘 재고 — 배정된 것 + 창고에 있는 것 전부. 태그 목록 화면의 원천.
   *
   * 미배정 비콘은 판정 파이프라인을 안 타므로 존·좌표가 없다. 대신 유휴 기록에서
   * 마지막 신호를 붙여 준다 — 배터리가 죽었는지, 창고에 있는지 이걸로 본다.
   */
  if (req.url === '/beacons') {
    /**
     * 테스트 장비를 껐으면 목업 비콘은 **여기서도 빠진다.**
     *
     * 추적만 끊고 이 목록을 그대로 두면 "실장비만" 이라고 해놓고 등록/반납 화면에는
     * 가짜가 23개 남는다 — 앞뒤가 안 맞고, 끈 상태에서 목업에 환자를 배정할 일도 없다.
     */
    const showTest = scanRouter.isTestGearOn();
    const rows = listBeacons(db)
      .filter((b) => showTest || !isTestTag(b.tagId))
      .map((b) => {
        const idle = b.personId ? undefined : idleBeacons.get(b.tagId);
        return {
          ...b,
          pin: pinOf(b.tagId),
          claimed: b.personId !== null && isClaimed(db, b.tagId),
          assigned: b.personId !== null,
          group: tagMeta.all()[b.tagId]?.group ?? 'unassigned',
          name: tagMeta.all()[b.tagId]?.name ?? null,
          // 비콘 설명 ('창고 3번 서랍') — 장비 관리 화면이 여기서 읽어 고친다
          memo: tagMeta.all()[b.tagId]?.memo ?? null,
          lastSeen: idle?.lastSeen ?? null,
          lastGateway: idle?.gatewayId ?? null,
          lastRssi: idle?.rssi ?? null,
        };
      });
    res.writeHead(200, CORS_JSON);
    res.end(JSON.stringify(rows));
    return;
  }
  // 게이트웨이 설치 위치 — 직원 화면의 '게이트웨이 범위' 보기가 쓴다.
  // 태그 위치가 아니라 천장 설비 배치도라 권한 구분이 필요 없다 (정적 마스터).
  if (req.url === '/gateways') {
    // 파일이 아니라 **지금 쓰고 있는 목록**을 준다 — 테스트 장비를 끄면 실장비만 남고,
    // 화면도 그걸 그대로 그려야 한다 (파일을 읽으면 껐는데 50대가 계속 뜬다)
    res.writeHead(200, { ...CORS_JSON, 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(gateways));
    return;
  }
  // 태그 이름/메모 — 관제·직원 화면 공용
  if (req.url === '/tag-meta') {
    if (req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      res.end(JSON.stringify(tagMeta.all()));
      return;
    }
    if (req.method === 'POST') {
      // content-type 을 명시 안 해 preflight 없는 simple request 로 받음
      let body = '';
      req.on('data', (c) => {
        body += c;
        if (body.length > 10_000) req.destroy(); // 방어
      });
      req.on('end', () => {
        try {
          const { tagId, name, memo, group } = JSON.parse(body) as {
            tagId: string;
            name?: string;
            memo?: string;
            group?: string;
          };
          /**
           * `name` 을 아예 안 보내면 **지금 값을 그대로 둔다** (빈 문자열은 '지우기'로 남긴다).
           *
           * 장비 관리 화면은 그룹·메모만 고치는데, 거기서 이름을 같이 보내면 그 순간
           * 비콘을 들고 있는 사람의 이름을 화면이 들고 있던 낡은 값으로 되돌린다.
           */
          const cur = tagMeta.all()[tagId];
          const who = name === undefined ? (cur?.name ?? '') : name.trim();
          tagMeta.set(tagId, who, (memo ?? '').trim(), group);
          // 이름은 한 값이다 — 사람 쪽도 같이 바꿔야 환자 등록/반납과 어긋나지 않는다
          renameHolder(db, tagId, who);
          res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
          res.end(JSON.stringify({ ok: true }));
        } catch {
          res.writeHead(400, { 'Access-Control-Allow-Origin': '*' });
          res.end(JSON.stringify({ ok: false }));
        }
      });
      return;
    }
  }
  // 환자용 캐릭터 커스터마이징 — 첫 진입 시 GET 이 비면 선택 화면을 띄운다.
  // 브라우저 스토리지 금지(불변식 B-5)라 서버가 personId 기준으로 보관한다.
  if (req.url?.startsWith('/patient-profile')) {
    const cors = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' };
    if (req.method === 'GET') {
      const token = new URL(req.url, 'http://localhost').searchParams.get('token') ?? '';
      const claims = verifyToken(token, SERVER_CONFIG.jwtSecret);
      if (!claims) {
        res.writeHead(401, cors);
        res.end(JSON.stringify({ error: 'unauthorized' }));
        return;
      }
      res.writeHead(200, cors);
      res.end(JSON.stringify(getPatientProfile(db, claims.personId)));
      return;
    }
    if (req.method === 'POST') {
      let body = '';
      req.on('data', (c) => {
        body += c;
        if (body.length > 4_000) req.destroy();
      });
      req.on('end', () => {
        try {
          const { token, charId, nickname } = JSON.parse(body) as {
            token: string;
            charId: string;
            nickname?: string;
          };
          const claims = verifyToken(token, SERVER_CONFIG.jwtSecret);
          // 모르는 캐릭터 id 는 거절 (클라이언트 입력을 그대로 신뢰하지 않음).
          // 조합형은 파츠 432개 조합이라 목록으로 못 막는다 — 형식으로 막는다
          if (!claims || typeof charId !== 'string' || !isValidCharId(charId)) {
            res.writeHead(claims ? 400 : 401, cors);
            res.end(JSON.stringify({ ok: false }));
            return;
          }
          upsertPatientProfile(db, claims.personId, charId, (nickname ?? '').trim().slice(0, 12));
          res.writeHead(200, cors);
          res.end(JSON.stringify({ ok: true }));
        } catch {
          res.writeHead(400, cors);
          res.end(JSON.stringify({ ok: false }));
        }
      });
      return;
    }
  }
  /**
   * 미등록 신호 목록 — 관제 "미등록 신호" 패널이 폴링한다.
   *
   * 여기 뜨는 ID 는 화이트리스트에서 걸러져 **판정·좌표·로그 어디에도 안 들어간**
   * 것들이다. 등록 화면 하나만 이 목록을 본다.
   */
  if (req.url === '/unknown-tags') {
    res.writeHead(200, { ...CORS_JSON, 'Cache-Control': 'no-store' });
    res.end(JSON.stringify({ stats: scanRouter.stats(), sightings: unknownTags.list() }));
    return;
  }
  /**
   * 비콘을 재고에 등록 → 그 즉시 화이트리스트를 통과해 추적이 시작된다.
   * 장비 도착 첫날 비콘 100개를 이걸로 올린다 (게이트웨이 코앞에 대면 맨 위로 뜸).
   *
   * ⚠️ 인증 없음 — /tag-meta 와 같은 수준이다. 관제 인증을 붙일 때 이 세 엔드포인트
   *    (/tag-meta, /unknown-tags, /register-tag)를 한 번에 staff 토큰 뒤로 옮길 것.
   */
  /**
   * 팔찌 QR 로 환자 화면 들어오기.
   *
   * QR 에는 **핀(비콘 뒷 6자리)** 이 들어간다. 토큰을 넣으면 안 된다 — 토큰은 만료되는데
   * 인쇄물은 안 바뀐다.
   *
   * **처음 찍은 기기가 그 배정을 차지한다.** 핀은 팔찌에 인쇄돼 안 바뀌는데 환자는
   * 바뀌므로, 이게 없으면 아침 환자가 브라우저 기록의 링크를 오후에 눌러 지금 그 팔찌를
   * 든 사람의 위치를 본다. 데스크에서 팔찌를 받자마자 찍게 하면 실질적으로 예전 환자가
   * 이길 틈이 없다.
   */
  if (req.url === '/patient-token' && req.method === 'POST') {
    readBody(req, 1_000, (body) => {
      try {
        const { pin } = JSON.parse(body) as { pin?: string };
        const found = findBeaconByPin(db, pin ?? '');
        if (found === 'none') throw new Error('없는 번호입니다');
        if (found === 'ambiguous') throw new Error('번호가 겹칩니다 — 데스크에 문의하세요');

        const claim = claimAssignment(db, found.tagId);
        if (claim === 'none') throw new Error('아직 등록되지 않은 팔찌입니다');
        if (claim === 'already') throw new Error('이미 사용 중인 팔찌입니다 — 데스크에 문의하세요');

        const personId = patientForToken(found.tagId);
        res.writeHead(200, CORS_JSON);
        res.end(
          JSON.stringify({
            ok: true,
            token: signToken({ personId, type: 'patient' }, SERVER_CONFIG.jwtSecret),
          }),
        );
      } catch (e) {
        res.writeHead(400, CORS_JSON);
        res.end(JSON.stringify({ ok: false, error: (e as Error).message }));
      }
    });
    return;
  }

  /**
   * 테스트 장비 스위치 — 끄면 **실장비만** 돈다.
   *
   * 화면 필터가 아니라 스캔 관문에서 막는다. 계획 배치 게이트웨이(GW-xx)와 목업
   * 비콘이 판정·좌표·체류 로그·관제 피드 어디에도 안 들어간다 — 그래야 "지금 깔린
   * 장비로 실제로 뭐가 되나" 가 보인다.
   *
   * ⚠️ 실장비가 아직 2대뿐이라 끄면 화면이 거의 빈다. 그게 지금의 정직한 그림이다.
   */
  if (req.url === '/test-gear') {
    if (req.method === 'GET') {
      res.writeHead(200, CORS_JSON);
      res.end(
        JSON.stringify({
          on: scanRouter.isTestGearOn(),
          realGateways: REAL_GATEWAYS.size,
          gateways: gateways.length,
        }),
      );
      return;
    }
    if (req.method === 'POST') {
      readBody(req, 200, (body) => {
        try {
          const { on } = JSON.parse(body) as { on?: boolean };
          const want = on !== false;
          scanRouter.setTestGear(want);

          /**
           * **게이트웨이 목록 자체를 갈아끼운다.**
           *
           * 처음엔 스캔만 막았는데 그러면 반쪽이었다 — 계획 배치로 띄운 서버는 실장비
           * 2대를 아예 안 싣고 있어서(두 파일이 겹치지 않는 별개 목록), 가짜를 막고 나면
           * 남은 실장비가 "미등록 게이트웨이" 라 존 판정이 안 됐다. 스위치는 껐는데
           * 남은 회선에 배선이 없는 꼴이었다.
           *
           * 재시작 없이 바꾸는 길은 이미 있다 — 현장에서 게이트웨이를 등록할 때 쓰는
           * 그 경로(`/register-gateway`)와 같은 세 줄이다.
           */
          gateways = want ? loadGateways() : loadRealGateways();
          gatewayZoneMap = buildGatewayZoneMap(gateways);
          engine.setGatewayZoneMap(gatewayZoneMap);
          estimator.setGateways(gateways);

          // 스캔만 끊으면 sweepAbsent 가 치울 때까지 몇 분 남는다 — 껐으면 바로 없어져야 한다
          const dropped = want ? 0 : engine.forget(isTestTag);
          if (!want) {
            for (const tagId of [...smoothed.keys()]) if (isTestTag(tagId)) smoothed.delete(tagId);
          }
          console.log(
            `[server] 테스트 장비 ${want ? 'ON' : 'OFF — 실장비만'}: 게이트웨이 ${gateways.length}대`
              + (dropped ? ` · 목업 태그 ${dropped}개 정리` : ''),
          );
          res.writeHead(200, CORS_JSON);
          res.end(
            JSON.stringify({ ok: true, on: want, gateways: gateways.length, dropped }),
          );
        } catch (e) {
          res.writeHead(400, CORS_JSON);
          res.end(JSON.stringify({ ok: false, error: (e as Error).message }));
        }
      });
      return;
    }
  }

  /** 데스크용 — 환자가 폰을 바꾸거나 기록을 지웠을 때 다시 찍게 풀어준다 */
  if (req.url === '/reset-claim' && req.method === 'POST') {
    readBody(req, 1_000, (body) => {
      try {
        const { tagId } = JSON.parse(body) as { tagId?: string };
        if (!tagId) throw new Error('tagId 없음');
        resetClaim(db, tagId);
        console.log(`[server] 진입 초기화: ${tagId}`);
        res.writeHead(200, CORS_JSON);
        res.end(JSON.stringify({ ok: true }));
      } catch (e) {
        res.writeHead(400, CORS_JSON);
        res.end(JSON.stringify({ ok: false, error: (e as Error).message }));
      }
    });
    return;
  }

  /**
   * 환자 등록 — 비콘을 지금 온 사람에게 넘긴다 (인포 데스크).
   *
   * 이름은 **사람이 손으로 친다.** 베가스 CRM 연동은 나중이고, 그때도 이 자리를
   * 자동으로 채워주는 것뿐이라 API 모양은 그대로 간다.
   *
   * 그룹은 비콘에 이미 붙어 있는 것을 쓴다 — 환자 팔찌는 patient, 간호사 배지는 nurse 로
   * 하드웨어 등록 때 정해진다. 등록할 때마다 다시 고르게 하면 실수만 는다.
   */
  if (req.url === '/assign' && req.method === 'POST') {
    readBody(req, 2_000, (body) => {
      try {
        const { tagId, name } = JSON.parse(body) as { tagId?: string; name?: string };
        if (!tagId) throw new Error('tagId 없음');
        const label = (name ?? '').trim();
        if (!label) throw new Error('이름을 입력하세요');

        /**
         * 배정은 열려 있던 배정을 먼저 닫는다(assignBeacon) — 인포에서 반납을 안 찍고
         * 바로 다음 환자에게 넘기는 일이 실제로 생긴다. 그때 앞 사람의 안내가 살아 있으면
         * **새 환자가 앞 사람의 목적지로 안내된다.** 배정 전에 끊는다.
         */
        guidance.clear(tagId);
        navLog.aborted(tagId);

        const group = (tagMeta.all()[tagId]?.group ?? 'patient') as TagGroup;
        const { personId } = assignBeacon(db, { tagId, displayName: label, group });
        // 화면에 뜰 이름을 지금 사람 것으로. 메모는 비콘 설명이라 그대로 둔다
        tagMeta.set(tagId, label, tagMeta.all()[tagId]?.memo ?? '', group);
        assignedTags.reload(); // 다음 스캔부터 추적·화면 노출
        idleBeacons.forget(tagId);

        console.log(`[server] 환자 등록: ${tagId} → ${label} (${group}, ${personId})`);
        res.writeHead(200, CORS_JSON);
        res.end(JSON.stringify({ ok: true, personId }));
      } catch (e) {
        res.writeHead(400, CORS_JSON);
        res.end(JSON.stringify({ ok: false, error: (e as Error).message }));
      }
    });
    return;
  }

  /**
   * 반납 — 비콘을 창고로. 배정이 닫히고 캐릭터 프로필이 지워진다.
   * 표시 이름도 지운다: 다음 사람이 올 때까지 앞 환자 이름이 목록에 남아 있으면 안 된다.
   */
  if (req.url === '/release' && req.method === 'POST') {
    readBody(req, 2_000, (body) => {
      try {
        const { tagId } = JSON.parse(body) as { tagId?: string };
        if (!tagId) throw new Error('tagId 없음');
        releaseBeacon(db, tagId);
        tagMeta.set(tagId, '', tagMeta.all()[tagId]?.memo ?? '', tagMeta.all()[tagId]?.group);
        assignedTags.reload();
        /**
         * 이동 중에 반납되면 그 안내는 끝을 볼 수 없다 — 추적이 끊기니 도착 판정이 안 온다.
         * 화살표와 이력을 같이 끊어야 메신저에 "영원히 이동 중" 이 남지 않는다.
         */
        guidance.clear(tagId);
        navLog.aborted(tagId);

        console.log(`[server] 반납: ${tagId}`);
        res.writeHead(200, CORS_JSON);
        res.end(JSON.stringify({ ok: true }));
      } catch (e) {
        res.writeHead(400, CORS_JSON);
        res.end(JSON.stringify({ ok: false, error: (e as Error).message }));
      }
    });
    return;
  }

  /**
   * 방 안내 — 직원용 패널에서 "이 환자를 이 방으로".
   * `zoneId` 를 비우면 해제. 도착하면 서버가 알아서 푼다(아래 좌표 방송 참고).
   */
  if (req.url === '/guide' && req.method === 'POST') {
    readBody(req, 2_000, (body) => {
      try {
        const { tagId, zoneId } = JSON.parse(body) as { tagId?: string; zoneId?: string | null };
        if (!tagId) throw new Error('tagId 없음');
        if (zoneId) {
          // 없는 방·직원 구역으로 안내를 걸면 환자 화면이 갈 곳 없는 화살표를 그린다
          const zone = loadZones().find((z) => z.zoneId === zoneId);
          // 분류상 진료실이어도 손님 통제구역 안에 있으면 안내 대상이 아니다
          // (직원이 도면에 칠해 준 구역 — tools/build-staff-areas.py)
          if (!zone || !isGuidableZone(zone) || inStaffArea(zone.tilePosition)) {
            throw new Error(`안내할 수 없는 방: ${zoneId}`);
          }
          guidance.set(tagId, zoneId, Date.now());
          /**
           * 이력을 남긴다 — 출발지는 **지금 판정된 방**(복도·자리비움이면 null).
           * 화살표를 세운 뒤에 적는 이유는 없다(순서는 무관); 다만 이력이 먼저 실패하면
           * 화살표만 서는 상태가 되므로, 실패는 catch 로 같이 400 이 되게 둔다.
           */
          navLog.issue(tagId, zoneId, engine.getState(tagId)?.currentZone ?? null);
        } else {
          guidance.clear(tagId);
          navLog.cancelled(tagId);
        }
        patient.guide(tagId, zoneId ?? null);
        console.log(`[server] 방 안내: ${tagId} → ${zoneId ?? '해제'}`);
        res.writeHead(200, CORS_JSON);
        res.end(JSON.stringify({ ok: true }));
      } catch (e) {
        res.writeHead(400, CORS_JSON);
        res.end(JSON.stringify({ ok: false, error: (e as Error).message }));
      }
    });
    return;
  }

  /**
   * 방 안내 이력 — `?limit=`, `?tag=`, `?person=` 로 좁힌다.
   *
   * 알림톡 연동이 읽어 갈 자리이자, 지금은 "안내가 제대로 닫히고 있나" 를 눈으로 보는 창구다.
   * 진행 중(`moving`)인 줄도 같이 나온다 — 안 나오면 이동 중인 환자를 조회할 수 없다.
   */
  if (req.url?.startsWith('/nav-logs')) {
    const url = new URL(req.url, 'http://localhost');
    const logs = navLog.list({
      limit: Number(url.searchParams.get('limit') ?? 100),
      tagId: url.searchParams.get('tag') ?? undefined,
      personId: url.searchParams.get('person') ?? undefined,
    });
    res.writeHead(200, CORS_JSON);
    res.end(JSON.stringify({ logs }));
    return;
  }

  /**
   * 피드백 메모 — 직원이 화면에서 바로 남기는 버그 신고·개선안.
   *
   * `GET /feedback` 목록 (기본: 미처리 먼저), `POST /feedback` 작성,
   * `POST /feedback/status` 처리함/되돌리기, `POST /feedback/delete` 삭제.
   */
  if (req.url?.startsWith('/feedback') && req.method === 'GET') {
    const url = new URL(req.url, 'http://localhost');
    const st = url.searchParams.get('status');
    const notes = listFeedback(db, {
      limit: Number(url.searchParams.get('limit') ?? 100),
      status: st === 'open' || st === 'done' ? st : undefined,
    });
    res.writeHead(200, CORS_JSON);
    res.end(JSON.stringify({ notes, open: countOpenFeedback(db) }));
    return;
  }

  if (req.url === '/feedback' && req.method === 'POST') {
    // 본문이 길 수 있다 — 재현 절차를 여러 줄로 적는 게 이 기능의 목적이다
    readBody(req, 20_000, (raw) => {
      try {
        const { kind, body, author, context } = JSON.parse(raw) as {
          kind?: string;
          body?: string;
          author?: string;
          context?: string;
        };
        const text = (body ?? '').trim();
        if (!text) throw new Error('내용을 입력하세요');
        const k = (['bug', 'idea', 'etc'].includes(kind ?? '') ? kind : 'etc') as FeedbackKind;
        const id = insertFeedback(db, {
          kind: k,
          body: text,
          author: (author ?? '').trim() || null,
          context: (context ?? '').trim() || null,
          /* 어느 기기·브라우저였는지. 신고자가 적을 수 없는 값이고, 특정 브라우저에서만
             나는 문제를 가릴 때 이것 하나로 갈린다. */
          userAgent: (req.headers['user-agent'] ?? '').slice(0, 300) || null,
          createdAt: Date.now(),
        });
        console.log(`[server] 피드백 #${id} (${k}): ${text.slice(0, 60).replace(/\s+/g, ' ')}`);
        res.writeHead(200, CORS_JSON);
        res.end(JSON.stringify({ ok: true, id, open: countOpenFeedback(db) }));
      } catch (e) {
        res.writeHead(400, CORS_JSON);
        res.end(JSON.stringify({ ok: false, error: (e as Error).message }));
      }
    });
    return;
  }

  if (req.url === '/feedback/status' && req.method === 'POST') {
    readBody(req, 500, (raw) => {
      try {
        const { id, status } = JSON.parse(raw) as { id?: number; status?: string };
        if (!id) throw new Error('id 없음');
        const st = status === 'done' ? 'done' : 'open';
        if (!setFeedbackStatus(db, id, st, Date.now())) throw new Error(`없는 메모: ${id}`);
        res.writeHead(200, CORS_JSON);
        res.end(JSON.stringify({ ok: true, open: countOpenFeedback(db) }));
      } catch (e) {
        res.writeHead(400, CORS_JSON);
        res.end(JSON.stringify({ ok: false, error: (e as Error).message }));
      }
    });
    return;
  }

  if (req.url === '/feedback/delete' && req.method === 'POST') {
    readBody(req, 500, (raw) => {
      try {
        const { id } = JSON.parse(raw) as { id?: number };
        if (!id) throw new Error('id 없음');
        if (!deleteFeedback(db, id)) throw new Error(`없는 메모: ${id}`);
        res.writeHead(200, CORS_JSON);
        res.end(JSON.stringify({ ok: true, open: countOpenFeedback(db) }));
      } catch (e) {
        res.writeHead(400, CORS_JSON);
        res.end(JSON.stringify({ ok: false, error: (e as Error).message }));
      }
    });
    return;
  }

  if (req.url === '/register-tag' && req.method === 'POST') {
    readBody(req, 4_000, (body) => {
      try {
        const { tagId, name, group, memo } = JSON.parse(body) as {
          tagId: string;
          name?: string;
          group?: string;
          memo?: string;
        };
        const g = (TAG_GROUP_IDS.includes(group as TagGroup) ? group : 'unassigned') as TagGroup;
        if (!tagId) throw new Error('tagId 없음');

        /**
         * 이름을 안 넣으면 **빈 채로 둔다.**
         *
         * 예전엔 비면 `tagId` 를 넣었고, 관제 등록창은 거기에 `비콘 1`, `비콘 2` … 를
         * 자동으로 채워 줬다. 그 값이 그대로 **사람 이름**(persons.display_name)이 되어,
         * 등록/반납 화면의 환자 자리에 `비콘 5` 가 떴다. 비콘을 가리키는 이름은 6자리
         * 코드 하나면 되고, 사람 이름 자리에는 사람 이름만 있어야 한다.
         */
        const label = (name ?? '').trim();
        // 등록(하드웨어)과 배정(사람)을 같이 한다 — 관제에서 등록하면 바로 추적되던
        // 기존 동작을 유지하기 위해서다. 인포의 배정/반납은 아래 별도 API 를 쓴다.
        registerBeacon(db, tagId, label);
        const { personId } = assignBeacon(db, { tagId, displayName: label, group: g });
        assignedTags.reload(); // 배정 즉시 화면에 뜨게
        idleBeacons.forget(tagId); // 이제 정식 파이프라인이 맡는다
        // 표시 이름은 캐시 일관성 때문에 스토어를 거친다 (관제·직원 화면으로 즉시 방송됨)
        tagMeta.set(tagId, label, (memo ?? '').trim(), g);
        knownTags.reload(); // 다음 스캔부터 통과
        unknownTags.forget(tagId); // 미등록 목록에서 즉시 제거

        console.log(`[server] 태그 등록: ${tagId} → ${label} (${g}, ${personId})`);
        res.writeHead(200, CORS_JSON);
        res.end(JSON.stringify({ ok: true, personId, knownTags: knownTags.size() }));
      } catch (e) {
        res.writeHead(400, CORS_JSON);
        res.end(JSON.stringify({ ok: false, error: (e as Error).message }));
      }
    });
    return;
  }
  /**
   * 녹화 정답 마크 — 걸으면서 "지금 이 방" 을 사람이 찍는다.
   * 이게 없으면 재생은 되는데 채점을 못 한다 (판정이 바뀐 건 보여도 좋아졌는지 모름).
   */
  if (req.url === '/record/mark' && req.method === 'POST') {
    readBody(req, 1_000, (body) => {
      if (!recorder) {
        res.writeHead(409, CORS_JSON);
        res.end(JSON.stringify({ ok: false, error: '녹화 중이 아님 (RECORD_SCANS 미설정)' }));
        return;
      }
      try {
        const { zoneId, tagId } = JSON.parse(body) as { zoneId: string | null; tagId?: string };
        recorder.mark(zoneId ?? null, tagId);
        res.writeHead(200, CORS_JSON);
        res.end(JSON.stringify({ ok: true, ...recorder.stats() }));
      } catch {
        res.writeHead(400, CORS_JSON);
        res.end(JSON.stringify({ ok: false }));
      }
    });
    return;
  }
  /**
   * 등록 안 된 채 신호를 쏘고 있는 게이트웨이 — 현장 설치 발견용.
   *
   * 게이트웨이를 달아도 `gateways.json` 에 없으면 판정에서 조용히 버려져 **화면에 아무
   * 흔적이 없다**. 그래서 MAC 을 알아내려고 장비 웹페이지를 뒤져야 했다(실제로 그랬다).
   * 게다가 이 장비는 네트워크 카드 MAC 과 페이로드에 실리는 MAC 이 끝자리가 다르다 —
   * 스티커를 보고 넣으면 영원히 안 맞는다. 그러니 **실제로 온 값**을 보여주는 게 맞다.
   */
  if (req.url === '/unknown-gateways') {
    res.writeHead(200, { ...CORS_JSON, 'Cache-Control': 'no-store' });
    res.end(
      JSON.stringify({
        registered: gateways.map((g) => ({ gatewayId: g.gatewayId, zoneId: g.zoneId })),
        unknown: scanRouter.unknownGatewayList(),
      }),
    );
    return;
  }
  /**
   * 게이트웨이를 존에 배정하고 **재시작 없이** 반영한다.
   * 45대를 다는 동안 매번 서버를 재시작할 수 없고, JSON 을 손으로 찍는 것도 오타 지옥이다.
   *
   * ⚠️ 인증 없음 — /tag-meta·/register-tag 와 같은 수준. 한 번에 staff 토큰 뒤로 옮길 것.
   */
  if (req.url === '/register-gateway' && req.method === 'POST') {
    readBody(req, 2_000, (body) => {
      try {
        const raw = JSON.parse(body) as {
          gatewayId: string;
          zoneId: string;
          label?: string;
          tile?: { x: number; y: number };
          /** 손으로 친 MAC 을 다른 것으로 고칠 때 — 이 값이 지금 목록에 있는 쪽이다 */
          prevGatewayId?: string;
        };
        const zone = loadZones().find((z) => z.zoneId === raw.zoneId);
        const gatewayId = normalizeMac(raw.gatewayId);
        if (!raw.gatewayId) throw new Error('gatewayId 없음');
        if (!gatewayId) throw new Error(`MAC 형식이 아닙니다: ${raw.gatewayId}`);
        if (!zone) throw new Error(`모르는 zoneId: ${raw.zoneId}`);

        const list = loadGateways();
        // MAC 을 고치는 수정이면 옛 줄을 먼저 뺀다 — 안 그러면 유령 게이트웨이가 남는다
        const prev = raw.prevGatewayId ? normalizeMac(raw.prevGatewayId) : '';
        const before = prev && prev !== gatewayId ? list.find((g) => g.gatewayId === prev) : undefined;
        if (before) list.splice(list.indexOf(before), 1);

        const at = list.findIndex((g) => g.gatewayId === gatewayId);
        const old = at >= 0 ? list[at] : before;
        const moved = old !== undefined && old.zoneId !== raw.zoneId;
        /** 옛 구역의 이름표 위치 — 사람이 좌표를 준 적 없다는 표시다 (등록할 때 넣는 자리표시자) */
        const oldAnchor = old ? loadZones().find((z) => z.zoneId === old.zoneId)?.tilePosition : undefined;
        const isPlaceholder = (t: { x: number; y: number } | undefined): boolean =>
          !!t && !!oldAnchor && t.x === oldAnchor.x && t.y === oldAnchor.y;

        const given =
          raw.tile && Number.isFinite(raw.tile.x) && Number.isFinite(raw.tile.y)
            ? { x: Math.round(raw.tile.x), y: Math.round(raw.tile.y) }
            : undefined;
        /**
         * 설치 좌표는 **덮어쓰지 않는다** — 단, 구역을 옮겼는데 좌표가 옛 방 이름표
         * 그대로면 따라 옮긴다.
         *
         * 두 규칙이 다 필요하다.
         * - 현장에서 실측 지점을 넣어 둔 게이트웨이의 구역만 고쳤을 때 좌표가 조용히
         *   라벨 위치로 되돌아가면 안 된다 (그래서 준 값을 우선한다).
         * - 반대로 자리표시 좌표를 그대로 들고 방을 옮기면 **존 판정만 새 방이고 도면
         *   마커는 옛 방에 남는다.** 실제로 상담실 4 → 대기공간 2 로 옮겼는데 게이트웨이가
         *   상담실 4 에 그대로 그려졌다 — 화면이 조용히 거짓말을 하는 쪽이라 더 나쁘다.
         */
        const tile =
          given && !(moved && isPlaceholder(given))
            ? given
            : !moved && old?.tile
              ? old.tile
              : { x: zone.tilePosition.x, y: zone.tilePosition.y };
        /**
         * 라벨도 같은 이유로 따라간다 — 서버가 지어 준 `상담실 4 게이트웨이` 가 대기공간 2
         * 줄에 남아 있으면 목록만 보고는 어느 쪽이 맞는지 알 수 없다.
         * 사람이 손으로 쓴 라벨은 그 사람의 말이라 건드리지 않는다.
         */
        const wasAuto = (l: string | undefined): boolean =>
          !l?.trim() || loadZones().some((z) => l.trim() === `${z.name} 게이트웨이`);
        const asked = (raw.label ?? '').trim();
        const label =
          asked && !(moved && wasAuto(asked))
            ? asked
            : !moved && old?.label
              ? old.label
              : `${zone.name} 게이트웨이`;
        const entry: Gateway = { gatewayId, zoneId: raw.zoneId, label, tile };
        if (at >= 0) list[at] = entry;
        else list.push(entry);

        // 재시작 없이 즉시 반영 (관문·판정·좌표추정·관제 표 전부)
        applyGateways(list);
        scanRouter.forgetGateway(gatewayId);
        if (before) scanRouter.forgetGateway(before.gatewayId);

        console.log(
          `[server] 게이트웨이 ${at >= 0 || before ? '수정' : '등록'}: ${gatewayId} → ${zone.name}`
            + ` (총 ${list.length}대)`,
        );
        res.writeHead(200, CORS_JSON);
        res.end(JSON.stringify({ ok: true, gateways: list.length, entry }));
      } catch (e) {
        res.writeHead(400, CORS_JSON);
        res.end(JSON.stringify({ ok: false, error: (e as Error).message }));
      }
    });
    return;
  }
  /**
   * 게이트웨이 삭제 — 떼어 낸 장비, 잘못 친 MAC 을 목록에서 뺀다.
   *
   * 지운 뒤에도 그 장비가 살아서 신호를 보내면 "미등록 게이트웨이" 로 다시 뜬다.
   * 그게 맞다 — 목록에서 뺐다고 전파가 멈추지는 않으니, 화면은 그 사실을 보여줘야 한다.
   */
  if (req.url === '/delete-gateway' && req.method === 'POST') {
    readBody(req, 1_000, (body) => {
      try {
        const { gatewayId } = JSON.parse(body) as { gatewayId?: string };
        const id = normalizeMac(gatewayId ?? '');
        if (!id) throw new Error('gatewayId 없음');
        const list = loadGateways();
        const at = list.findIndex((g) => g.gatewayId === id);
        if (at < 0) throw new Error(`목록에 없는 게이트웨이: ${id}`);
        list.splice(at, 1);

        applyGateways(list);
        scanRouter.forgetGateway(id);

        console.log(`[server] 게이트웨이 삭제: ${id} (총 ${list.length}대)`);
        res.writeHead(200, CORS_JSON);
        res.end(JSON.stringify({ ok: true, gateways: list.length }));
      } catch (e) {
        res.writeHead(400, CORS_JSON);
        res.end(JSON.stringify({ ok: false, error: (e as Error).message }));
      }
    });
    return;
  }
  /**
   * 비콘 **입고** — 하드웨어 대장에만 올린다. 사람은 안 붙는다 (창고행).
   *
   * `/register-tag`(관제)와 다른 점이 여기다. 관제 쪽은 "지금 신호가 오는 미등록 비콘을
   * 보고 바로 추적을 시작한다" 는 흐름이라 등록과 배정을 같이 한다. 장비 관리는
   * **박스로 들어온 팔찌 100개를 대장에 올리는** 일이라 사람이 없다 — 창고에 있는 상태가
   * 정상이고, 환자에게 넘기는 건 인포의 '환자 등록' 이 따로 한다.
   */
  if (req.url === '/register-beacon' && req.method === 'POST') {
    readBody(req, 4_000, (body) => {
      try {
        const { tagId, group, memo } = JSON.parse(body) as {
          tagId?: string;
          group?: string;
          memo?: string;
        };
        const id = normalizeMac(tagId ?? '');
        if (!tagId) throw new Error('tagId 없음');
        if (!id) throw new Error(`MAC 형식이 아닙니다: ${tagId}`);
        const exists = findBeacon(db, id);
        // 이미 있는 비콘을 '신규 등록' 으로 또 올리면 아무 일도 안 일어난 것처럼 보인다.
        // 폐기된 것을 다시 올리는 건 되살리기라 허용한다 (registerBeacon 이 retired=0 로 되돌린다)
        if (exists && !exists.retired) throw new Error(`이미 등록된 비콘입니다: ${id}`);
        const g = (TAG_GROUP_IDS.includes(group as TagGroup) ? group : 'unassigned') as TagGroup;

        registerBeacon(db, id);
        /**
         * 이름은 **비우고** 그룹·메모만 붙인다. 비콘의 이름은 6자리 코드 하나고,
         * 이름 칸은 그 비콘을 지금 든 사람의 자리다 (환자 등록이 채운다).
         */
        tagMeta.set(id, '', (memo ?? '').trim(), g);
        knownTags.reload(); // 다음 스캔부터 화이트리스트 통과 → 창고에서도 마지막 신호가 잡힌다
        unknownTags.forget(id);

        console.log(`[server] 비콘 입고: ${id} (${g}) — 창고`);
        res.writeHead(200, CORS_JSON);
        res.end(JSON.stringify({ ok: true, tagId: id, pin: pinOf(id), knownTags: knownTags.size() }));
      } catch (e) {
        res.writeHead(400, CORS_JSON);
        res.end(JSON.stringify({ ok: false, error: (e as Error).message }));
      }
    });
    return;
  }
  /**
   * 비콘 폐기 — 분실·고장으로 재고에서 뺀다.
   *
   * 줄을 지우지 않고 `retired` 표시만 남긴다 (schema.sql 참고). 체류 기록·안내 이력이
   * 이 tag_id 를 가리키고 있어서, 진짜로 지우면 지난 기록이 주인 없는 값이 된다.
   * 화면에서는 사라지고 화이트리스트에서도 빠지므로 운영상으로는 삭제와 같다.
   */
  if (req.url === '/delete-beacon' && req.method === 'POST') {
    readBody(req, 1_000, (body) => {
      try {
        const { tagId } = JSON.parse(body) as { tagId?: string };
        const id = normalizeMac(tagId ?? '');
        if (!id) throw new Error('tagId 없음');
        if (!findBeacon(db, id)) throw new Error(`등록되지 않은 비콘: ${id}`);

        // 들고 있는 사람이 있으면 배정부터 닫힌다 (retireBeacon 안에서 release)
        retireBeacon(db, id);
        // 이동 중이었다면 도착 판정을 해 줄 사람이 없다 — 화살표와 이력을 같이 끊는다
        guidance.clear(id);
        navLog.aborted(id);
        knownTags.reload(); // 다음 스캔부터 관문에서 막힌다
        assignedTags.reload();
        idleBeacons.forget(id);
        engine.forget((t) => t === id); // 화면에 남은 아바타를 바로 치운다
        smoothed.delete(id);

        console.log(`[server] 비콘 폐기: ${id}`);
        res.writeHead(200, CORS_JSON);
        res.end(JSON.stringify({ ok: true, knownTags: knownTags.size() }));
      } catch (e) {
        res.writeHead(400, CORS_JSON);
        res.end(JSON.stringify({ ok: false, error: (e as Error).message }));
      }
    });
    return;
  }
  /**
   * ── 채널톡(채널 웍스) 알림 연동 테스트 ─────────────────────────────
   * GET  /channeltalk-test      버튼 눌러 손으로 확인하는 테스트 페이지
   * GET  /channeltalk/status    키 설정 여부 + 기본값 (키 자체는 절대 안 나간다)
   * GET  /channeltalk/managers  멘션·공지 대상 고르기용 매니저 목록
   * GET  /channeltalk/groups    팀챗 그룹 목록
   * POST /channeltalk/send      { kind:'group'|'announce', managerId, managerName, text, group? }
   *
   * 채널톡 호출이 전부 서버 경유인 이유: 키를 프론트에 주면 안 되고(비밀값),
   * api.channel.io 는 브라우저 CORS 도 막혀 있다.
   * ⚠️ 인증 없음 — /register-gateway 와 같은 수준. staff 토큰 뒤로 같이 옮길 것.
   *    공개 배포에 키를 올리면 아무나 이 경로로 팀챗에 글을 쓸 수 있다.
   */
  /**
   * 채널톡 손테스트 창구(`/channeltalk-test` + `/channeltalk/*`)는 **개발 모드에만 있다.**
   *
   * 화면 코드는 이걸 쓰지 않는다 — 알림은 서버가 내부에서 직접 보낸다. 사람이 손으로
   * 확인할 때만 쓰는 창구인데, 열어 두면 아무나 원내 팀챗에 메시지를 밀어 넣을 수 있다.
   * 그래서 배포에서는 401 이 아니라 **없는 경로**로 만든다 (있다는 사실조차 안 알린다).
   * 배포에서 손테스트가 필요하면 `DEV_TOKEN=1` 로 잠깐 켠다.
   */
  if (req.url?.startsWith('/channeltalk') && !SERVER_CONFIG.devTokens) {
    res.writeHead(404, CORS_JSON);
    res.end(JSON.stringify({ ok: false, error: 'not found' }));
    return;
  }
  if (req.url === '/channeltalk-test') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(channelTalkTestPageHtml());
    return;
  }
  if (req.url === '/channeltalk/status') {
    res.writeHead(200, CORS_JSON);
    res.end(
      JSON.stringify({
        configured: channelTalkConfigured(),
        botName: SERVER_CONFIG.channelTalk.botName,
        group: SERVER_CONFIG.channelTalk.group,
        managerId: SERVER_CONFIG.channelTalk.managerId,
      }),
    );
    return;
  }
  if (req.url === '/channeltalk/managers' || req.url === '/channeltalk/groups') {
    const call = req.url === '/channeltalk/managers' ? listManagers : listGroups;
    void call().then((r) => {
      // 채널톡 쪽 실패(키 오류·요금제·429)는 502 로 구분한다 — 400 은 우리 요청 문제
      res.writeHead(r.ok ? 200 : 502, CORS_JSON);
      res.end(JSON.stringify(r));
    });
    return;
  }
  if (req.url === '/channeltalk/send' && req.method === 'POST') {
    readBody(req, 4_000, (body) => {
      void (async () => {
        try {
          const { kind, managerId, managerName, text, group } = JSON.parse(body) as {
            kind?: 'group' | 'announce';
            managerId?: string;
            managerName?: string;
            text?: string;
            group?: string;
          };
          const msg = (text ?? '').trim();
          if (!msg) throw new Error('text 없음');
          if (!managerId) throw new Error('managerId 없음 — 매니저 목록에서 선택');

          let r: ChannelTalkResult;
          if (kind === 'announce') {
            // 그룹을 안 거치고 그 사람 알림함으로 직행 (봇이 팀챗 DM 을 열어주는 API 는 없다)
            r = await announceToManager(managerId, msg);
          } else {
            const g = (group ?? '').trim() || SERVER_CONFIG.channelTalk.group;
            if (!g) throw new Error('group 없음 — 그룹 목록에서 선택하거나 CHANNELTALK_GROUP 설정');
            r = await sendGroupMessage(
              g,
              `${mentionMarkup(managerId, managerName ?? 'manager')} ${escapeMarkup(msg)}`,
            );
          }
          console.log(`[server] 채널톡 ${kind ?? 'group'} 전송 → HTTP ${r.status}${r.ok ? '' : ' 실패'}`);
          res.writeHead(r.ok ? 200 : 502, CORS_JSON);
          res.end(JSON.stringify(r));
        } catch (e) {
          res.writeHead(400, CORS_JSON);
          res.end(
            JSON.stringify({ ok: false, status: 0, body: { error: (e as Error).message } }),
          );
        }
      })();
    });
    return;
  }
  // 실시간 관제 페이지 (하드웨어 디버깅/현장 튜닝) — 서버 자체 서빙, CDN 불필요
  if (req.url === '/monitor' || req.url?.startsWith('/monitor?')) {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(monitorPageHtml());
    return;
  }
  /**
   * ⚠️ 개발 전용 — 핀 없이 토큰을 내준다. `devTokens` 가 꺼지면(배포 이미지의
   *    NODE_ENV=production) **없는 경로**가 된다.
   *
   * 직원용 화면은 이제 `/staff-token` 을 쓴다. 이게 남아 있는 이유는 환자용 QR 손테스트
   * (`?type=patient&tag=<MAC>`)와 `tools/pos-check.ts` 다.
   */
  if (req.url?.startsWith('/dev-token')) {
    if (!SERVER_CONFIG.devTokens) {
      res.writeHead(404, CORS_JSON);
      res.end(JSON.stringify({ ok: false, error: 'not found' }));
      return;
    }
    const url = new URL(req.url, 'http://localhost');
    const claims =
      url.searchParams.get('type') === 'patient'
        ? ({ personId: patientForToken(url.searchParams.get('tag')), type: 'patient' } as const)
        : STAFF_CLAIMS;
    res.writeHead(200, {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
    });
    res.end(JSON.stringify({ token: signToken(claims, SERVER_CONFIG.jwtSecret) }));
    return;
  }
  // API 라우트를 전부 지나온 뒤에 화면 파일을 찾는다 (API 경로가 항상 우선)
  if (serveStatic(req, res)) return;
  res.writeHead(404);
  res.end();
});

const { io, patient } = createWsServer(
  httpServer,
  SERVER_CONFIG.jwtSecret,
  presence,
  db,
  tagMeta,
  (tagId) => guidance.get(tagId)?.zoneId ?? null,
  () => guidance.all(),
);

// 안내가 바뀌면 직원 화면 전체에 알린다 (누가 어디로 가는 중인지 목록·도면에 표시)
guidance.onChange((all) => io.of('/staff').emit('guide:all', all));

// 관제 허브 (/monitor namespace) — io 준비 후 초기화
monitor = new MonitorHub(io, engine, estimator, gateways, loadZones(), tagMeta, () => ({
  stats: scanRouter.stats(),
  unknown: unknownTags.list(),
  recording: recorder ? recorder.stats() : null,
}));

// 태그 이름/메모 변경 → 관제·직원 화면 양쪽 실시간 반영
tagMeta.onChange((map) => {
  io.of('/monitor').emit('tagmeta', map);
  io.of('/staff').emit('tagmeta', map);
});

// 연속 위치 추정 브로드캐스트 (트래킹 시각화 — 0.5초 주기)
// TODO: 권한 매트릭스 확정 후 visibleTargets 필터 경유로 변경 (지금은 staff 전체)
// 내부적으로 자주 추정해 EMA 로 평활 → RSSI 노이즈로 아바타가 떨지 않게
/** 존 중심 좌표 — 추정치가 판정된 방을 벗어나지 않게 붙잡는 데 쓴다 */
const zoneCenters = new Map(loadZones().map((z) => [z.zoneId, z.tilePosition]));
/**
 * 목줄이 붙잡을 기준 존은 **안정화된 쪽**을 쓴다.
 *
 * 원시 판정은 태그당 분당 3회 가까이 흔들린다(실측). 그 값을 그대로 목줄 기준으로 삼으면
 * 방이 바뀔 때마다 좌표를 다른 방 중심으로 끌어당겨, 결국 두 방 사이를 왕복하는
 * **진동기**가 된다 — 고치려던 증상을 내가 만드는 꼴이었다.
 */
const leashZone = new ZoneDwellFilter(ZONE_DWELL_MS);

const smoothed = new Map<
  string,
  { x: number; y: number; zone: string | null; inTransit?: boolean }
>();
setInterval(() => {
  const maxStep = (SERVER_CONFIG.maxSpeedPxPerSec * SERVER_CONFIG.posSampleMs) / 1000;

  for (const p of estimator.estimateAll()) {
    /**
     * 평활은 태그마다 다르다 — 드문드문 들리는 비콘만 세게 누르고 나머지는 빠르게 둔다.
     *
     * 빈도를 **듣고 있는 게이트웨이 수로 나눈다.** 합계는 배치가 촘촘할수록 커져서,
     * 같은 비콘이 게이트웨이를 늘렸다는 이유만으로 '빠른 태그' 가 되어 버린다.
     */
    const heard = engine.readingsOf(p.tagId).length || 1;
    const total = scanRate.rateOf(p.tagId);
    const a = smoothingFor(total === null ? null : total / heard, {
      normal: SERVER_CONFIG.posSmoothing,
      slow: SERVER_CONFIG.posSmoothingSlow,
      slowBelow: SERVER_CONFIG.slowTagRate,
    });
    let target = walkable.clamp(p.x, p.y);

    /**
     * **존 목줄** — 추정 좌표를 판정된 방 근처로 붙잡는다.
     *
     * 존 판정(히스테리시스 + 연속확인)과 좌표 추정(RSSI 가중평균)은 서로 독립이라
     * 얼마든지 어긋난다. 그 결과가 "목록엔 시술실 2 체류 1분인데 점은 딴 데서 돌아다님"
     * 이다(실제로 신고됨). 둘 중 **존 판정이 안정된 쪽**이므로 좌표를 거기에 맞춘다.
     */
    const steadyZone = leashZone.update(p.tagId, p.zone);
    const center = steadyZone ? zoneCenters.get(steadyZone) : undefined;
    if (center) {
      const dx = target.x - center.x;
      const dy = target.y - center.y;
      const dist = Math.hypot(dx, dy);
      if (dist > SERVER_CONFIG.zoneLeashPx) {
        const k = SERVER_CONFIG.zoneLeashPx / dist;
        target = walkable.clamp(center.x + dx * k, center.y + dy * k);
      }
    }

    const prev = smoothed.get(p.tagId);
    if (!prev) {
      smoothed.set(p.tagId, { x: target.x, y: target.y, zone: p.zone, inTransit: p.inTransit });
      continue;
    }

    // EMA 평활 (RSSI 노이즈로 떨지 않게)
    let nx = prev.x + (target.x - prev.x) * a;
    let ny = prev.y + (target.y - prev.y) * a;

    /**
     * **속도 제한** — 사람은 순간이동하지 않는다.
     *
     * 가중평균은 태그를 듣는 게이트웨이 집합이 바뀔 때(창 3초를 들고 나면서) 불연속으로
     * 튄다. 그러면 화면에서 점이 방을 가로질러 날아간다(녹화로 확인). EMA 는 그걸
     * 부드럽게 만들 뿐 **막지는 못한다** — 진동이 계속되면 두 지점 사이를 왕복한다.
     * 사람이 낼 수 있는 속도라는 물리적 상한을 여기서 강제하면 프론트는 볼 일이 없다.
     */
    const stepX = nx - prev.x;
    const stepY = ny - prev.y;
    const step = Math.hypot(stepX, stepY);
    if (step > maxStep) {
      nx = prev.x + (stepX / step) * maxStep;
      ny = prev.y + (stepY / step) * maxStep;
    }

    const c = walkable.clamp(nx, ny); // 보정 결과가 벽에 걸릴 수 있다
    smoothed.set(p.tagId, { x: c.x, y: c.y, zone: p.zone, inTransit: p.inTransit });
  }
  // 추적 종료된 태그 정리
  const live = new Set(estimator.estimateAll().map((p) => p.tagId));
  for (const tagId of smoothed.keys()) if (!live.has(tagId)) smoothed.delete(tagId);
}, SERVER_CONFIG.posSampleMs);

// 운영 화면에는 평활된 좌표를 낮은 빈도로 전송 (프론트가 그 사이를 걸어서 이동)
setInterval(() => {
  const list = [...smoothed.entries()].map(([tagId, s]) => {
    // EMA 결과가 벽에 걸릴 수 있으므로 다시 보정
    const c = walkable.clamp(s.x, s.y);
    return { tagId, x: c.x, y: c.y, zone: s.zone, inTransit: s.inTransit };
  });
  if (list.length === 0) return;
  io.of('/staff').emit('pos:update', list);
  /**
   * 목적지 방에 들어왔으면 안내를 푼다 (판정 규칙은 GuidanceStore.arrived 참고).
   *
   * ⚠️ **여기서 외부 API(알림톡)를 기다리면 안 된다.** 이 루프는 전 화면의 좌표 방송이라,
   *    메신저가 3초 버벅이면 모든 아바타가 3초 멈춘다. 이력은 DB 에 적기만 하고
   *    (better-sqlite3 는 동기여도 인덱스 조회 한 번이라 빠르다), 발송은 앞으로 붙일
   *    발송함 워커가 navLog.onEvent 를 받아 **이 루프 밖에서** 한다.
   */
  for (const g of guidance.arrived(list)) {
    const done = navLog.arrived(g.tagId);
    guidance.clear(g.tagId);
    patient.guide(g.tagId, null);
    console.log(
      `[server] 방 안내 도착: ${g.tagId} → ${g.zoneId}`
        + (done?.travelSec != null ? ` (${done.travelSec}초 소요)` : ''),
    );
  }
  // 환자 화면도 같은 좌표를 쓴다 (도트 스킨 + 확대만 다른 같은 그림).
  // 본인 좌표는 항상, 다른 사람은 patientSeesEveryone 이 켜졌을 때만 —
  // 익명화·본인 제외 판단은 patient namespace 안에 있다 (불변식 B-1 관련).
  patient.positions(list);
}, SERVER_CONFIG.posBroadcastMs);

httpServer.listen(SERVER_CONFIG.httpPort, () => {
  console.log(`[server] listening on :${SERVER_CONFIG.httpPort} (ws: /patient, /staff, /monitor)`);
  console.log(`[server] gateways: ${gateways.length}, mqtt: ${SERVER_CONFIG.mqttUrl}`);
  console.log(`[server] 관제 페이지: http://localhost:${SERVER_CONFIG.httpPort}/monitor`);
  const ws = walkable.stats();
  console.log(`[server] walkable: ${ws.cols}x${ws.rows} cell=${ws.cell}px, 통행가능 ${ws.walkable} 셀`);
  // 화이트리스트 상태는 반드시 부팅 로그에 남긴다 — 장비 붙였는데 아무것도 안 뜰 때
  // 제일 먼저 볼 곳이 여기다 (등록 안 된 비콘은 설계대로 전부 차단된다)
  console.log(
    SERVER_CONFIG.tagWhitelist
      ? `[server] 태그 화이트리스트 ON — 등록 ${knownTags.size()}개만 추적. 미등록 비콘은 관제 "미등록 신호" 에서 등록`
      : `[server] ⚠️ 태그 화이트리스트 OFF — 주변 BLE 전부 추적 (디버깅 전용, 운영 금지)`,
  );
  if (recorder) console.log(`[server] 스캔 녹화 중 → ${recorder.path}`);
});
