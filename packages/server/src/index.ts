import { createServer } from 'node:http';
import { buildGatewayZoneMap, loadGateways, loadZones, SERVER_CONFIG, ZONE_ENGINE_CONFIG } from './config/index.js';
import { ZoneEngine } from './zone-engine/zone-engine.js';
import { MqttIngestion } from './ingestion/mqtt-ingestion.js';
import { GenericJsonAdapter } from './ingestion/adapters/generic-json.adapter.js';
import { PresenceService } from './presence/presence-service.js';
import { openDb } from './db/index.js';
import { createWsServer } from './ws/index.js';

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
  res.writeHead(404);
  res.end();
});

createWsServer(httpServer, SERVER_CONFIG.jwtSecret, presence, db);

httpServer.listen(SERVER_CONFIG.httpPort, () => {
  console.log(`[server] listening on :${SERVER_CONFIG.httpPort} (ws: /patient, /staff)`);
  console.log(`[server] gateways: ${gateways.length}, mqtt: ${SERVER_CONFIG.mqttUrl}`);
});
