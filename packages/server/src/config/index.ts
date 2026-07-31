import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import type { FloorplanMeta, Gateway, Zone } from '@meditracker/shared';

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
  /**
   * 존 판정 주기 — 수신값이 들어올 때마다가 아니라 이 간격으로 묶어 평가한다.
   * ZONE_ENGINE_CONFIG.CONFIRM_COUNT 는 '이 주기 몇 번 연속' 이라는 뜻이 된다
   * (200ms × 3 = 0.6초 유지되면 존 전환 확정).
   */
  zoneEvalIntervalMs: Number(process.env.ZONE_EVAL_MS ?? 200),
  /**
   * 운영 화면 위치 브로드캐스트 주기 — 사람이 걷는 속도를 감안한 갱신 간격.
   * 너무 짧으면 RSSI 노이즈로 아바타가 떨고, 너무 길면 반응이 늦다.
   */
  posBroadcastMs: Number(process.env.POS_BROADCAST_MS ?? 3500),
  /** 내부 위치 추정 주기 (이 값들을 EMA 로 평활해 브로드캐스트) */
  posSampleMs: 500,
  /** EMA 계수 (0~1, 클수록 최신값 비중↑) */
  posSmoothing: 0.35,
  /**
   * 환자 화면에 **다른 사람들의 위치**를 보낼지 (기본 on — 시연·개발용).
   *
   * ⚠️ 켜면 설계서 불변식 B-1(환자 소켓으로 타인 좌표 전송 금지)을 벗어난다.
   *    "환자용은 직원용에 도트 스킨 씌운 같은 화면" 이라는 요구 때문에 켜 뒀다.
   *    이름·MAC 은 절대 나가지 않는다 — 익명 id + 좌표 + 손님/직원 구분만.
   *    실제 운영에서는 `PATIENT_SEES_EVERYONE=0` 으로 끄고 인원수만 노출한다.
   */
  patientSeesEveryone: process.env.PATIENT_SEES_EVERYONE !== '0',
};

export function loadZones(): Zone[] {
  return JSON.parse(readFileSync(join(here, 'zones.json'), 'utf-8'));
}

export function loadGateways(): Gateway[] {
  return JSON.parse(readFileSync(join(here, 'gateways.json'), 'utf-8'));
}

/** 도면 배경 이미지 메타 (프론트가 이 이미지 위에 존/아바타 매핑) */
export function loadFloorplan(): FloorplanMeta {
  return JSON.parse(readFileSync(join(here, 'floorplan.json'), 'utf-8'));
}

/** gatewayId → zoneId 매핑 테이블 */
export function buildGatewayZoneMap(gateways: Gateway[]): Map<string, string> {
  return new Map(gateways.map((g) => [g.gatewayId, g.zoneId]));
}
