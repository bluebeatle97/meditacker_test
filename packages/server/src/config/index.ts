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
  /**
   * 이 시간 무신호면 상태를 **메모리에서 완전히 제거**한다 (자리비움과 다름).
   * 자리비움은 "지금 안 보임" 이라 계속 들고 있어야 하지만, 반납된 태그·건물을 떠난
   * 태그까지 영원히 들고 있으면 Map 이 단조 증가한다. 자리비움보다 훨씬 길게 잡아
   * 잠깐 신호가 끊긴 사람이 목록에서 사라지지 않게 한다.
   */
  EVICT_AFTER_MS: 600000, // 10분
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
   * 운영 화면 위치 브로드캐스트 주기.
   *
   * 예전엔 3.5초였다 — "너무 짧으면 RSSI 노이즈로 아바타가 떤다" 는 이유였는데,
   * **떨림은 이미 서버가 EMA(posSampleMs 500ms, posSmoothing 0.35)로 잡고 있어서**
   * 그 목적이라면 중복이었다. 주기가 길수록 프론트가 외삽하는 구간이 길어지고,
   * 직원용·환자용 두 화면이 그 사이에 서로 벌어질 여지도 커진다.
   * 태그 수십 개 기준 트래픽은 무시할 수준이라 짧게 잡는 편이 낫다.
   */
  posBroadcastMs: Number(process.env.POS_BROADCAST_MS ?? 1500),
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
  /**
   * 시연용 환자 화면이 붙을 비콘 — 직원 화면의 '손님 1'.
   * 비콘마다 QR 을 붙이면 `/dev-token?type=patient&tag=<MAC>` 로 각자의 화면이 열리고,
   * 그때까지는 이 태그 하나에 고정한다 (정렬 순서에 기대면 시드가 바뀔 때 딴 사람이 잡힌다).
   */
  demoPatientTag: process.env.DEMO_PATIENT_TAG ?? 'AA:BB:CC:00:00:01',
  /**
   * 등록된 태그만 추적할지 (기본 **on**).
   *
   * 끄면 게이트웨이가 올린 모든 BLE 식별자를 추적한다 — 지나가는 폰·이어버드·워치까지.
   * 메모리가 단조 증가하고, 동의 없는 단말 수집이 되므로 운영에서 끄면 안 된다.
   * 디버깅용 탈출구로만 `TAG_WHITELIST=0`.
   */
  tagWhitelist: process.env.TAG_WHITELIST !== '0',
  /**
   * raw 스캔 녹화 파일 이름 (`RECORD_SCANS=walk-1` → data/recordings/walk-1.ndjson).
   * 현장 튜닝용 — 한 번 걸어서 녹화해두면 파라미터를 바꿔가며 오프라인에서 무한 재생할 수 있다.
   * `RECORD_SCANS=1` 처럼 아무 값이나 주면 시각 기반 이름으로 저장한다.
   */
  recordScans: process.env.RECORD_SCANS ?? null,
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
