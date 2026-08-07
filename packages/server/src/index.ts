import { createServer, type IncomingMessage } from 'node:http';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  buildGatewayZoneMap,
  gatewaysFilePath,
  loadFloorplan,
  loadGateways,
  loadZones,
  SERVER_CONFIG,
  ZONE_ENGINE_CONFIG,
} from './config/index.js';
import { ZoneEngine } from './zone-engine/zone-engine.js';
import { MqttIngestion } from './ingestion/mqtt-ingestion.js';
import { AutoAdapter } from './ingestion/adapters/auto.adapter.js';
import { PresenceService } from './presence/presence-service.js';
import { PositionEstimator } from './presence/position-estimator.js';
import { WalkableMap } from './presence/walkable-map.js';
import {
  assignBeacon,
  claimAssignment,
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
  upsertPatientProfile,
} from './db/index.js';
import { createWsServer } from './ws/index.js';
import { signToken, verifyToken } from './auth/jwt.js';
import { MonitorHub } from './monitor/monitor-hub.js';
import { monitorPageHtml } from './monitor/monitor-page.js';
import { createStaticHandler } from './web/static-files.js';
import { TagMetaStore } from './presence/tag-meta-store.js';
import { KnownTagStore } from './presence/known-tag-store.js';
import { AssignedTagStore } from './presence/assigned-tag-store.js';
import { IdleBeaconStore } from './presence/idle-beacon-store.js';
import { UnknownTagBuffer } from './ingestion/unknown-tag-buffer.js';
import { ScanRouter } from './ingestion/scan-router.js';
import { ScanRecorder } from './recording/scan-recorder.js';
import {
  PATIENT_CHARACTERS,
  TAG_GROUP_IDS,
  ZoneDwellFilter,
  ZONE_DWELL_MS,
  type PatientCharacter,
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
/** 게이트웨이→존 매핑. 현장 등록 시 이 변수를 갈아치우고 엔진에도 밀어 넣는다 */
let gatewayZoneMap = buildGatewayZoneMap(gateways);
const engine = new ZoneEngine(gatewayZoneMap, ZONE_ENGINE_CONFIG);

const presence = new PresenceService(engine, db);
const estimator = new PositionEstimator(gateways, engine);
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

// 현장 튜닝용 raw 스캔 녹화 (RECORD_SCANS 가 있을 때만)
const recorder = SERVER_CONFIG.recordScans
  ? new ScanRecorder(SERVER_CONFIG.recordScans, gateways, ZONE_ENGINE_CONFIG)
  : null;

/**
 * 모든 스캔이 지나는 단일 관문. 등록 태그만 아래로 내려보낸다.
 * 미등록(지나가는 폰·이어버드·워치, 15분마다 바뀌는 랜덤 MAC)은 여기서 끝 —
 * 판정·좌표·로그·관제 피드 어디에도 안 들어가고 등록 화면에만 잠깐 뜬다.
 */
const scanRouter = new ScanRouter(
  knownTags,
  unknownTags,
  (scan) => {
    engine.ingest(scan, false);
    dirtyTags.add(scan.tagId);
    monitor?.recordScan(scan); // 관제 피드로 raw 스캔 탭
    recorder?.record(scan); // 녹화 중이면 원본 그대로 적재
  },
  SERVER_CONFIG.tagWhitelist,
  (gatewayId) => gatewayZoneMap.has(gatewayId),
  (tagId) => assignedTags.has(tagId),
  idleBeacons,
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

const CORS_JSON = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' };

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
    const rows = listBeacons(db).map((b) => {
      const idle = b.personId ? undefined : idleBeacons.get(b.tagId);
      return {
        ...b,
        pin: pinOf(b.tagId),
        claimed: b.personId !== null && isClaimed(db, b.tagId),
        assigned: b.personId !== null,
        group: tagMeta.all()[b.tagId]?.group ?? 'unassigned',
        name: tagMeta.all()[b.tagId]?.name ?? null,
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
    res.writeHead(200, CORS_JSON);
    res.end(JSON.stringify(loadGateways()));
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
          tagMeta.set(tagId, (name ?? '').trim(), (memo ?? '').trim(), group);
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
          // 모르는 캐릭터 id 는 거절 (클라이언트 입력을 그대로 신뢰하지 않음)
          if (!claims || !PATIENT_CHARACTERS.includes(charId as PatientCharacter)) {
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

        const label = (name ?? '').trim() || tagId;
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
        registered: loadGateways().map((g) => ({ gatewayId: g.gatewayId, zoneId: g.zoneId })),
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
        const { gatewayId, zoneId, label } = JSON.parse(body) as {
          gatewayId: string;
          zoneId: string;
          label?: string;
        };
        const zone = loadZones().find((z) => z.zoneId === zoneId);
        if (!gatewayId) throw new Error('gatewayId 없음');
        if (!zone) throw new Error(`모르는 zoneId: ${zoneId}`);

        const list = loadGateways();
        const entry = {
          gatewayId,
          zoneId,
          label: (label ?? '').trim() || `${zone.name} 게이트웨이`,
          // 설치 지점을 사람이 알려주기 전까지는 그 방의 라벨 위치를 쓴다
          tile: { x: zone.tilePosition.x, y: zone.tilePosition.y },
        };
        const at = list.findIndex((g) => g.gatewayId === gatewayId);
        if (at >= 0) list[at] = entry;
        else list.push(entry);
        writeFileSync(gatewaysFilePath(), JSON.stringify(list, null, 2) + '\n');

        // 재시작 없이 즉시 반영 (관문·판정·좌표추정·관제 표 전부)
        gateways = list;
        gatewayZoneMap = buildGatewayZoneMap(list);
        engine.setGatewayZoneMap(gatewayZoneMap);
        estimator.setGateways(list);
        monitor?.setGateways(list);
        scanRouter.forgetGateway(gatewayId);

        console.log(`[server] 게이트웨이 등록: ${gatewayId} → ${zone.name} (총 ${list.length}대)`);
        res.writeHead(200, CORS_JSON);
        res.end(JSON.stringify({ ok: true, gateways: list.length, entry }));
      } catch (e) {
        res.writeHead(400, CORS_JSON);
        res.end(JSON.stringify({ ok: false, error: (e as Error).message }));
      }
    });
    return;
  }
  // 실시간 관제 페이지 (하드웨어 디버깅/현장 튜닝) — 서버 자체 서빙, CDN 불필요
  if (req.url === '/monitor' || req.url?.startsWith('/monitor?')) {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(monitorPageHtml());
    return;
  }
  // ⚠️ 개발 전용 — 토큰 없이 화면 열면 프론트가 자동 호출. 실배포(Phase 2 로그인) 시 제거.
  if (req.url?.startsWith('/dev-token')) {
    const url = new URL(req.url, 'http://localhost');
    const claims =
      url.searchParams.get('type') === 'patient'
        ? ({ personId: patientForToken(url.searchParams.get('tag')), type: 'patient' } as const)
        : ({ personId: 'staff-doc-1', type: 'staff', role: 'doctor', dept: 'derma' } as const);
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

const { io, patient } = createWsServer(httpServer, SERVER_CONFIG.jwtSecret, presence, db, tagMeta);

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
  const a = SERVER_CONFIG.posSmoothing;
  const maxStep = (SERVER_CONFIG.maxSpeedPxPerSec * SERVER_CONFIG.posSampleMs) / 1000;

  for (const p of estimator.estimateAll()) {
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
