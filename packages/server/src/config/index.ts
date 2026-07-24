import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import type { Gateway, Zone } from '@meditracker/shared';

const here = dirname(fileURLToPath(import.meta.url));

/** 존 판정 튜닝 파라미터 (설계서 6.2 — 현장 테스트로 실측 조정) */
export const ZONE_ENGINE_CONFIG = {
  RSSI_WINDOW_MS: 3000, // 이 시간 내 스캔만 유효
  HYSTERESIS_DB: 8, // 새 존이 현재 존보다 이만큼 세야 전환 후보
  CONFIRM_COUNT: 3, // 후보존이 연속 N회 최강일 때 전환 확정
  ABSENT_TIMEOUT_MS: 15000, // 이 시간 신호 없으면 자리비움(null)
};

export const SERVER_CONFIG = {
  httpPort: Number(process.env.PORT ?? 8080),
  mqttUrl: process.env.MQTT_URL ?? 'mqtt://localhost:1883',
  mqttScanTopic: process.env.MQTT_SCAN_TOPIC ?? 'gw/+/scan', // gw/<gatewayId>/scan
  jwtSecret: process.env.JWT_SECRET ?? 'dev-only-change-me',
  dbPath: process.env.DB_PATH ?? join(here, '../../data/meditracker.db'),
  /** 자리비움 스윕 주기 */
  absentSweepIntervalMs: 5000,
};

export function loadZones(): Zone[] {
  return JSON.parse(readFileSync(join(here, 'zones.json'), 'utf-8'));
}

export function loadGateways(): Gateway[] {
  return JSON.parse(readFileSync(join(here, 'gateways.json'), 'utf-8'));
}

/** gatewayId → zoneId 매핑 테이블 */
export function buildGatewayZoneMap(gateways: Gateway[]): Map<string, string> {
  return new Map(gateways.map((g) => [g.gatewayId, g.zoneId]));
}
