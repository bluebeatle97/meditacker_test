import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildGatewayZoneMap, loadFloorplan, loadGateways, loadZones, SERVER_CONFIG, ZONE_ENGINE_CONFIG } from './config/index.js';
import { ZoneEngine } from './zone-engine/zone-engine.js';
import { MqttIngestion } from './ingestion/mqtt-ingestion.js';
import { GenericJsonAdapter } from './ingestion/adapters/generic-json.adapter.js';
import { PresenceService } from './presence/presence-service.js';
import { PositionEstimator } from './presence/position-estimator.js';
import { WalkableMap } from './presence/walkable-map.js';
import { getPatientProfile, openDb, upsertPatientProfile } from './db/index.js';
import { createWsServer } from './ws/index.js';
import { signToken, verifyToken } from './auth/jwt.js';
import { MonitorHub } from './monitor/monitor-hub.js';
import { monitorPageHtml } from './monitor/monitor-page.js';
import { TagMetaStore } from './presence/tag-meta-store.js';
import { PATIENT_CHARACTERS, type PatientCharacter } from '@meditracker/shared';

// ── 조립: Ingestion → Zone Engine → Presence/DB → Permission → WS ──────────

const configDir = join(dirname(fileURLToPath(import.meta.url)), 'config');

const db = openDb(SERVER_CONFIG.dbPath);

const gateways = loadGateways();
const engine = new ZoneEngine(buildGatewayZoneMap(gateways), ZONE_ENGINE_CONFIG);

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
const ingestion = new MqttIngestion(
  SERVER_CONFIG.mqttUrl,
  SERVER_CONFIG.mqttScanTopic,
  new GenericJsonAdapter(),
  (scan) => {
    engine.ingest(scan, false);
    dirtyTags.add(scan.tagId);
    monitor?.recordScan(scan); // 관제 피드로 raw 스캔 탭
  },
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

// 자리비움 스윕 (ABSENT_TIMEOUT 판정)
setInterval(() => engine.sweepAbsent(), SERVER_CONFIG.absentSweepIntervalMs);

/**
 * 개발용 환자 토큰이 가리킬 사람.
 *
 * `?tag=<비콘MAC>` 을 주면 그 비콘을 든 사람으로 발급한다 — 비콘마다 QR 을 붙여
 * "찍으면 그 비콘의 환자 화면" 으로 들어가는 구조를 그대로 흉내낸 것이다.
 * 안 주면 **태그가 실제로 배정된** 첫 환자(손님 1). 고정 id 를 쓰면 시드가 바뀔 때
 * 추적 대상 없는 사람을 가리켜 환자 화면이 딴 세상처럼 보인다(실제로 그렇게 신고됨).
 */
function patientForToken(tagId: string | null): string {
  if (tagId) {
    const byTag = db
      .prepare(`SELECT person_id AS personId FROM tags WHERE tag_id = ? AND active = 1`)
      .get(tagId) as { personId: string } | undefined;
    if (byTag) return byTag.personId;
  }
  const row = db
    .prepare(
      `SELECT t.person_id AS personId FROM tags t JOIN persons p ON p.person_id = t.person_id
       WHERE t.active = 1 AND p.type = 'patient' ORDER BY t.tag_id LIMIT 1`,
    )
    .get() as { personId: string } | undefined;
  return row?.personId ?? 'patient-001';
}

const httpServer = createServer((req, res) => {
  if (req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, tags: engine.getAllStates().length }));
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
  res.writeHead(404);
  res.end();
});

const { io, patient } = createWsServer(httpServer, SERVER_CONFIG.jwtSecret, presence, db);

// 관제 허브 (/monitor namespace) — io 준비 후 초기화
monitor = new MonitorHub(io, engine, estimator, gateways, loadZones(), tagMeta);

// 태그 이름/메모 변경 → 관제·직원 화면 양쪽 실시간 반영
tagMeta.onChange((map) => {
  io.of('/monitor').emit('tagmeta', map);
  io.of('/staff').emit('tagmeta', map);
});

// 연속 위치 추정 브로드캐스트 (트래킹 시각화 — 0.5초 주기)
// TODO: 권한 매트릭스 확정 후 visibleTargets 필터 경유로 변경 (지금은 staff 전체)
// 내부적으로 자주 추정해 EMA 로 평활 → RSSI 노이즈로 아바타가 떨지 않게
const smoothed = new Map<string, { x: number; y: number; zone: string | null }>();
setInterval(() => {
  const a = SERVER_CONFIG.posSmoothing;
  for (const p of estimator.estimateAll()) {
    const c = walkable.clamp(p.x, p.y);
    const prev = smoothed.get(p.tagId);
    smoothed.set(
      p.tagId,
      prev
        ? { x: prev.x + (c.x - prev.x) * a, y: prev.y + (c.y - prev.y) * a, zone: p.zone }
        : { x: c.x, y: c.y, zone: p.zone },
    );
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
    return { tagId, x: c.x, y: c.y, zone: s.zone };
  });
  if (list.length === 0) return;
  io.of('/staff').emit('pos:update', list);
  // 환자 화면도 같은 좌표를 쓴다 (도트 스킨 + 확대만 다른 같은 그림).
  // 익명화·본인 제외는 patient namespace 가 처리한다. 운영에서 끄려면
  // PATIENT_SEES_EVERYONE=0 (설정 주석 참고 — 불변식 B-1).
  if (SERVER_CONFIG.patientSeesEveryone) patient.crowdPositions(list);
}, SERVER_CONFIG.posBroadcastMs);

httpServer.listen(SERVER_CONFIG.httpPort, () => {
  console.log(`[server] listening on :${SERVER_CONFIG.httpPort} (ws: /patient, /staff, /monitor)`);
  console.log(`[server] gateways: ${gateways.length}, mqtt: ${SERVER_CONFIG.mqttUrl}`);
  console.log(`[server] 관제 페이지: http://localhost:${SERVER_CONFIG.httpPort}/monitor`);
  const ws = walkable.stats();
  console.log(`[server] walkable: ${ws.cols}x${ws.rows} cell=${ws.cell}px, 통행가능 ${ws.walkable} 셀`);
});
