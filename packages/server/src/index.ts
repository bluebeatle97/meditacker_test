import { createServer } from 'node:http';
import { buildGatewayZoneMap, loadGateways, loadZones, SERVER_CONFIG, ZONE_ENGINE_CONFIG } from './config/index.js';
import { ZoneEngine } from './zone-engine/zone-engine.js';
import { MqttIngestion } from './ingestion/mqtt-ingestion.js';
import { GenericJsonAdapter } from './ingestion/adapters/generic-json.adapter.js';
import { PresenceService } from './presence/presence-service.js';
import { PositionEstimator } from './presence/position-estimator.js';
import { openDb } from './db/index.js';
import { createWsServer } from './ws/index.js';
import { signToken } from './auth/jwt.js';

// ── 조립: Ingestion → Zone Engine → Presence/DB → Permission → WS ──────────

const db = openDb(SERVER_CONFIG.dbPath);

const gateways = loadGateways();
const engine = new ZoneEngine(buildGatewayZoneMap(gateways), ZONE_ENGINE_CONFIG);

const presence = new PresenceService(engine, db);

const ingestion = new MqttIngestion(
  SERVER_CONFIG.mqttUrl,
  SERVER_CONFIG.mqttScanTopic,
  new GenericJsonAdapter(),
  (scan) => engine.ingest(scan),
);
ingestion.start();

// 자리비움 스윕 (ABSENT_TIMEOUT 판정)
setInterval(() => engine.sweepAbsent(), SERVER_CONFIG.absentSweepIntervalMs);

const httpServer = createServer((req, res) => {
  if (req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, tags: engine.getAllStates().length }));
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

// 연속 위치 추정 브로드캐스트 (트래킹 시각화 — 0.5초 주기)
// TODO: 권한 매트릭스 확정 후 visibleTargets 필터 경유로 변경 (지금은 staff 전체)
const estimator = new PositionEstimator(gateways, engine);
setInterval(() => {
  const positions = estimator.estimateAll();
  if (positions.length > 0) io.of('/staff').emit('pos:update', positions);
}, 500);

httpServer.listen(SERVER_CONFIG.httpPort, () => {
  console.log(`[server] listening on :${SERVER_CONFIG.httpPort} (ws: /patient, /staff)`);
  console.log(`[server] gateways: ${gateways.length}, mqtt: ${SERVER_CONFIG.mqttUrl}`);
});
