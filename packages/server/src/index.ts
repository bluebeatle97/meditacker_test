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
import { openDb } from './db/index.js';
import { createWsServer } from './ws/index.js';
import { signToken } from './auth/jwt.js';
import { MonitorHub } from './monitor/monitor-hub.js';
import { monitorPageHtml } from './monitor/monitor-page.js';
import { TagMetaStore } from './presence/tag-meta-store.js';

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

const ingestion = new MqttIngestion(
  SERVER_CONFIG.mqttUrl,
  SERVER_CONFIG.mqttScanTopic,
  new GenericJsonAdapter(),
  (scan) => {
    engine.ingest(scan);
    monitor?.recordScan(scan); // 관제 피드로 raw 스캔 탭
  },
);
ingestion.start();

// 존 전환을 관제 로그로 탭
presence.onChange((c) =>
  monitor?.recordZoneChange({ tagId: c.tagId, fromZone: c.fromZone, toZone: c.toZone, at: c.at }),
);

// 자리비움 스윕 (ABSENT_TIMEOUT 판정)
setInterval(() => engine.sweepAbsent(), SERVER_CONFIG.absentSweepIntervalMs);

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
  if (req.url === '/walkable') {
    res.writeHead(200, {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
      'Cache-Control': 'public, max-age=3600',
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
          const { tagId, name, memo } = JSON.parse(body) as { tagId: string; name?: string; memo?: string };
          tagMeta.set(tagId, (name ?? '').trim(), (memo ?? '').trim());
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
        ? ({ personId: 'patient-001', type: 'patient' } as const)
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

const io = createWsServer(httpServer, SERVER_CONFIG.jwtSecret, presence, db);

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
  if (list.length > 0) io.of('/staff').emit('pos:update', list);
}, SERVER_CONFIG.posBroadcastMs);

httpServer.listen(SERVER_CONFIG.httpPort, () => {
  console.log(`[server] listening on :${SERVER_CONFIG.httpPort} (ws: /patient, /staff, /monitor)`);
  console.log(`[server] gateways: ${gateways.length}, mqtt: ${SERVER_CONFIG.mqttUrl}`);
  console.log(`[server] 관제 페이지: http://localhost:${SERVER_CONFIG.httpPort}/monitor`);
  const ws = walkable.stats();
  console.log(`[server] walkable: ${ws.cols}x${ws.rows} cell=${ws.cell}px, 통행가능 ${ws.walkable} 셀`);
});
