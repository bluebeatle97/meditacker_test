import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import type { FloorplanMeta, Gateway, Zone } from '@meditracker/shared';

const here = dirname(fileURLToPath(import.meta.url));

/** 존 판정 튜닝 파라미터 (설계서 6.2 — 현장 테스트로 실측 조정) */
export const ZONE_ENGINE_CONFIG = {
  RSSI_WINDOW_MS: 3000, // 이 시간 내 스캔만 유효
  /**
   * 새 존이 현재 존보다 이만큼 세야 전환 후보 (`HYSTERESIS_DB=12` 로 덮어쓸 수 있다).
   *
   * 현장에서 재보니 **비콘·게이트웨이가 둘 다 가만히 있어도 RSSI 가 6dB 넘게 출렁인다**
   * (9분 연속 관측). 기본값 8 은 그 위에 겨우 2dB 얹은 값이라, 두 존의 세기 차이가
   * 작은 자리(복도·문간)에서는 전환이 계속 뒤집힌다. 그런 자리가 많으면 올린다.
   *
   * 다만 값을 올리는 건 **증상 완화**다. 차이가 작은 진짜 이유는 그 지점을 충분히 세게
   * 듣는 게이트웨이가 없다는 것이고, 그건 배치로만 풀린다.
   */
  HYSTERESIS_DB: Number(process.env.HYSTERESIS_DB ?? 8),
  /** 후보존이 연속 N회 최강일 때 전환 확정 (판정 주기 × N 만큼 버틴다) */
  CONFIRM_COUNT: Number(process.env.CONFIRM_COUNT ?? 3),
  ABSENT_TIMEOUT_MS: 15000, // 이 시간 신호 없으면 자리비움(null)
  /**
   * 이 시간 무신호면 상태를 **메모리에서 완전히 제거**한다 (자리비움과 다름).
   * 자리비움은 "지금 안 보임" 이라 계속 들고 있어야 하지만, 반납된 태그·건물을 떠난
   * 태그까지 영원히 들고 있으면 Map 이 단조 증가한다. 자리비움보다 훨씬 길게 잡아
   * 잠깐 신호가 끊긴 사람이 목록에서 사라지지 않게 한다.
   */
  EVICT_AFTER_MS: 600000, // 10분
  /**
   * 복도(방 사이) 판정 — **동시에 세게 들리는 존이 몇 개인가**.
   *
   * 복도에는 게이트웨이가 없어 nearest-anchor 는 무조건 옆방 이름을 찍는다. 복도에 서
   * 있는 사람이 "시술실 2 체류 1분" 으로 뜨는 이유다.
   *
   * 1·2위 세기 차이로 판정하는 방법을 먼저 시도했다가 버렸다 — 이 도면은 방이 작고
   * 게이트웨이가 촘촘해 "방 안 벽 근처" 도 차이가 작게 나와서 구분이 안 됐다(43% 오검출).
   * 실측 분포상 존 **개수**는 깨끗하게 갈린다: 1개 50%(방 안) / 2개 32%(문간) / 3개+ 18%.
   * 현장 배치가 다르면 녹화 리플레이로 다시 잡는다.
   */
  TRANSIT_NEAR_DB: Number(process.env.TRANSIT_NEAR_DB ?? 6),
  TRANSIT_MIN_ZONES: Number(process.env.TRANSIT_MIN_ZONES ?? 3),
  TRANSIT_CONFIRM: 3,
};

export const SERVER_CONFIG = {
  httpPort: Number(process.env.PORT ?? 8080),
  mqttUrl: process.env.MQTT_URL ?? 'mqtt://localhost:1883',
  /**
   * 구독할 스캔 토픽 (쉼표로 여러 개). 기본값이 둘인 이유:
   * - `gw/+/scan` — 목 게이트웨이(JSON). 로컬 개발·리플레이의 입력원
   * - `meditracker/scan` — 실장비 AB Gateway V4. 게이트웨이 50대가 **같은 토픽**을
   *   쓴다 (gatewayId 를 본문 MAC 에서 뽑으므로 토픽을 나눌 이유가 없다)
   */
  mqttScanTopics: (process.env.MQTT_SCAN_TOPIC ?? 'gw/+/scan,meditracker/scan')
    .split(',')
    .map((t) => t.trim())
    .filter(Boolean),
  /**
   * 실장비 비콘 MAC 바이트 순서 뒤집기 (`AB_MAC_REVERSE=1`).
   * 벤더 문서가 순서를 명시하지 않았다 — MAC 이 스티커에 적힌 실물 비콘을 게이트웨이
   * 앞에 대 보고, 관제 화면 값이 스티커와 뒤집혀 보이면 켠다.
   */
  abMacReverse: process.env.AB_MAC_REVERSE === '1',
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
  /**
   * EMA 계수 (0~1, 클수록 최신값 비중↑).
   *
   * 0.35 → 0.18 로 낮췄다. RSSI 무게중심은 게이트웨이 위치들의 가중평균이라 사람이
   * 움직이면 그 사이를 계단처럼 건너뛴다 — 이건 추정 방식 자체의 성질이라 없앨 수 없고,
   * **시간축으로 뭉개는 수밖에 없다**. 대가는 반응이 1~2초 늦어지는 것인데,
   * 존 단위 정밀도가 목표인 시스템(설계서 1장)에서는 남는 장사다.
   */
  posSmoothing: Number(process.env.POS_SMOOTHING ?? 0.18),
  /**
   * 추정 좌표가 낼 수 있는 최대 속도 (도면 px/초). 140px ≈ 2.2m/s = 빠른 걸음.
   *
   * RSSI 가중평균은 태그를 듣는 게이트웨이 집합이 바뀔 때 불연속으로 튄다 —
   * 화면에서는 점이 방을 가로질러 날아간다. EMA 는 그걸 부드럽게 할 뿐 막지 못한다.
   * "사람은 순간이동하지 않는다" 는 물리적 사실을 여기서 강제해, 두 프론트가 애초에
   * 불가능한 좌표를 받지 않게 한다.
   */
  maxSpeedPxPerSec: Number(process.env.MAX_SPEED_PX ?? 140),
  /**
   * 추정 좌표를 **판정된 존 중심에서** 이 거리 안으로 붙잡는다 (도면 px). 200px ≈ 3.2m.
   *
   * 존 판정과 좌표 추정은 서로 독립이라 어긋날 수 있다 — 목록엔 "시술실 2 체류 1분"
   * 인데 점은 딴 방을 돌아다니는 상태. 둘 중 존 판정이 안정된 쪽이라 좌표를 맞춘다.
   * 너무 조이면 방 안에서의 움직임이 죽으니 방 반지름보다 조금 크게 잡는다.
   */
  zoneLeashPx: Number(process.env.ZONE_LEASH_PX ?? 200),
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

/**
 * 손님끼리 서로 안 보이는 방의 **칸 마스크** (tools/build-rooms.py 산출).
 *
 * 없으면 null — 예전 배포에서도 서버가 뜨긴 해야 한다. 그때는 아무도 안 숨는다.
 */
export function loadPrivateArea(): {
  cell: number;
  cols: number;
  rows: number;
  grid: string[];
} | null {
  try {
    return JSON.parse(readFileSync(join(here, 'private-area.json'), 'utf-8'));
  } catch {
    return null;
  }
}

/**
 * 게이트웨이 목록. 기본은 **실제로 설치된 것**(`gateways.json`).
 *
 * 계획 배치 50대는 `gateways.planned.json` 에 따로 있다 — 실장비 실측 중에는 아직 안 달린
 * 게이트웨이가 화면에 섞이면 안 되기 때문이다. 배치 검토 도구는 그쪽을 지정해서 쓴다:
 *
 *   GATEWAYS_FILE=gateways.planned.json npm run gateway:plan -w @meditracker/server
 */
export function gatewaysFilePath(): string {
  return join(here, process.env.GATEWAYS_FILE ?? 'gateways.json');
}

export function loadGateways(): Gateway[] {
  return JSON.parse(readFileSync(gatewaysFilePath(), 'utf-8'));
}

/** 도면 배경 이미지 메타 (프론트가 이 이미지 위에 존/아바타 매핑) */
export function loadFloorplan(): FloorplanMeta {
  return JSON.parse(readFileSync(join(here, 'floorplan.json'), 'utf-8'));
}

/** gatewayId → zoneId 매핑 테이블 */
export function buildGatewayZoneMap(gateways: Gateway[]): Map<string, string> {
  return new Map(gateways.map((g) => [g.gatewayId, g.zoneId]));
}
