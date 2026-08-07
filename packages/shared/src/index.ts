export { ZoneDwellFilter, ZONE_DWELL_MS } from './zone-dwell.js';
export { MOCK_PROFILES, MOCK_TAGS, ROUTES, groupFromRoute, mockProfileFor } from './mock-tags.js';
export {
  CM_PER_PX,
  MOCK_WALK_PX_PER_SEC,
  buildRouteTimelines,
  positionAt,
  type RouteStop,
  type RouteTimeline,
} from './mock-walk.js';
export { DemoSim } from './demo-sim.js';
export {
  PATH_LOSS_N,
  RX_FLOOR,
  TX_AT_1M,
  USABLE_RSSI,
  WALL_LOSS_DB,
  rssiAt,
} from './rssi-model.js';
export {
  computeCoverage,
  coverageStats,
  wallsBetween,
  type BlockedGrid,
  type CoverageCell,
  type CoverageGateway,
  type CoverageResult,
  type CoverageStats,
} from './coverage.js';
export {
  ARRIVE_EPS_PX,
  DEFAULT_UPDATE_INTERVAL_MS,
  INTERPOLATION_OVERSHOOT,
  MAX_CATCHUP_MULT,
  UpdateClock,
  WALK_PX_PER_SEC,
  pathLengthPx,
  paceForPath,
  type Point,
} from './walk-pacing.js';

// ─── 정적 데이터 (설계서 5.1) ───────────────────────────────────────────────

export type ZoneType =
  | 'waiting'
  | 'consult'
  | 'surgery'
  | 'laser'
  | 'recovery'
  | 'skincare'
  | 'reception'
  | 'staff'
  | 'etc';

export type ZoneCategory = 'patient_area' | 'staff_area' | 'common';

export interface Zone {
  zoneId: string; // "waiting_1", "consult_1"
  name: string; // 도면 라벨 그대로 ("시술실 1")
  type: ZoneType;
  category: ZoneCategory;
  /** 도면 배경 이미지 픽셀 좌표 — 방 라벨 위치 (아바타/게이트웨이 기준점) */
  tilePosition: { x: number; y: number };
  socialEnabled: boolean; // 존 채팅 허용 여부
}

/**
 * 도면에만 표시되는 라벨 — 존이 아니다(추적 대상 없음).
 * 도면 PDF 에 이름이 있지만 방이 아닌 것(가구·설비): 대기석, 직원PC, 서브데스크, 실외기실.
 */
export interface MapAnnotation {
  text: string; // 도면 라벨 그대로
  x: number; // 도면 이미지 픽셀 좌표
  y: number;
}

/** 도면 배경 이미지 메타 — 프론트가 이 이미지를 깔고 tilePosition 을 그 위에 매핑 */
export interface FloorplanMeta {
  image: string; // public/ 에 놓인 파일명
  width: number;
  height: number;
  /** 방 이름은 Zone.name 이 단일 출처 — 여기엔 존 아닌 라벨만 둔다 */
  annotations?: MapAnnotation[];
}

export interface Gateway {
  gatewayId: string; // MAC 또는 고유 ID
  zoneId: string; // 이 게이트웨이가 커버하는 존
  label: string; // "대기실-천장-A"
  /** 게이트웨이 설치 위치 (타일 좌표) — RSSI 가중평균 연속 위치 계산용 */
  tile?: { x: number; y: number };
}

/**
 * 비콘 묶음 — 직원 화면 왼쪽 목록의 그룹 탭. 운영자가 태그마다 지정한다.
 * 하드웨어로 자동 구분(iBeacon UUID·MAC 프리픽스)이 붙기 전까지의 단일 출처.
 */
export type TagGroup = 'doctor' | 'nurse' | 'interpreter' | 'patient' | 'unassigned';
export const TAG_GROUP_IDS: readonly TagGroup[] = [
  'doctor',
  'nurse',
  'interpreter',
  'patient',
  'unassigned',
];

/** 태그에 운영자가 붙인 이름/메모/그룹 (관제·직원 화면에서 tagId 대신 표시) */
export interface TagMeta {
  name?: string;
  memo?: string;
  group?: TagGroup;
}
export type TagMetaMap = Record<string, TagMeta>;

/**
 * 환자용 화면 캐릭터. 첫 진입 시 고르고 서버에 저장한다
 * (⚠️ 불변식 B-5: 브라우저 스토리지 금지 — 그래서 서버 보관).
 * 태그 반납 시 초기화되므로 다음 환자에게 남지 않는다.
 */
export const PATIENT_CHARACTERS = ['adam', 'alex', 'amelia', 'bob'] as const;
export type PatientCharacter = (typeof PATIENT_CHARACTERS)[number];

/**
 * 조합형 캐릭터 id — 파츠 이름 5개를 `|` 로 이은 것
 * (`몸|눈|옷|머리|장식`, 만드는 쪽은 web-patient/char-builder.ts).
 * 장식은 '없음' 이 정상이라 뒤 4칸은 비어 있어도 된다.
 *
 * ⚠️ 이 값은 화면에서 **파일 경로**(`charparts/<칸>/<이름>.png`)가 된다.
 *    글자를 영숫자·밑줄로 묶어 두는 것이 경로를 벗어나지 못하게 하는 유일한 장치다.
 */
const COMPOSED_CHAR_ID = /^\w{1,40}(\|\w{0,40}){4}$/;

/** 저장해도 되는 캐릭터 id 인가 (예전 고정 4종 + 조합형) */
export function isValidCharId(id: string): boolean {
  return PATIENT_CHARACTERS.includes(id as PatientCharacter) || COMPOSED_CHAR_ID.test(id);
}

export interface PatientProfile {
  charId: PatientCharacter | string;
  nickname: string | null;
}

/** RSSI 가중평균으로 추정한 연속 위치 (타일 좌표, 트래킹 시각화용) */
export interface PositionEstimate {
  tagId: string;
  x: number;
  y: number;
  zone: string | null; // 존 엔진의 현재 판정 (병행 표시용)
  /**
   * 방 사이(복도) 이동 중 — `PresenceState.inTransit` 과 같은 값.
   *
   * 존 전환 이벤트(presence:update)는 존이 **바뀔 때만** 나가는데 복도 진입은 존 변화가
   * 아니라서 그 채널로는 전달되지 않는다. 주기 좌표 방송에 실어 보낸다.
   */
  inTransit?: boolean;
}

export type PersonType = 'patient' | 'staff';
export type StaffRole = 'doctor' | 'nurse' | 'manager' | 'staff';

export interface TagAssignment {
  tagId: string; // 비콘 UUID 또는 MAC
  assignedTo: string; // personId
  personType: PersonType;
  assignedAt: number; // 접수 시각 (환자 대기시간 기산점)
  active: boolean;
}

export interface Person {
  personId: string;
  type: PersonType;
  displayName: string; // 환자는 익명 별칭 권장 ("환자 A")
  role?: StaffRole; // 직원 전용
  dept?: string;
}

// ─── 런타임 상태 (설계서 5.2) ───────────────────────────────────────────────

export interface PresenceState {
  tagId: string;
  currentZone: string | null; // null = 추적구역 벗어남(자리비움)
  lastSeen: number;
  enteredAt: number; // 현재 존 진입 시각
  candidateZone?: string; // 전환 판정 중인 후보존
  candidateCount?: number; // 후보존 연속 카운트 (채터링 방지)
  /**
   * 어느 방으로도 신호가 확실히 기울지 않음 = **방 사이(복도) 이동 중**.
   *
   * 복도에는 게이트웨이가 없어서 nearest-anchor 는 어쩔 수 없이 옆방 이름을 찍는다.
   * 그러면 복도에 서 있는 사람이 "시술실 2 체류 1분" 으로 뜬다(실제로 그랬다).
   * 방 한가운데면 한 게이트웨이가 압도적이고 복도면 양쪽이 비슷하다는 성질을 이용해,
   * 1·2위 존의 세기 차이(margin)가 작으면 이 플래그를 세운다.
   *
   * `currentZone` 은 그대로 최선의 추측을 유지한다 — 지도에 점은 찍어야 하므로.
   * 바뀌는 건 **표시와 체류 타이머**뿐이다.
   */
  inTransit?: boolean;
  /** inTransit 전환 판정 중인 연속 카운트 (내부용) */
  transitCount?: number;
}

export interface PresenceLog {
  id: number;
  tagId: string;
  personId: string;
  zoneId: string;
  enteredAt: number;
  exitedAt: number | null;
  durationSec: number | null;
}

// ─── Ingestion 표준 이벤트 (설계서 6.1) ─────────────────────────────────────

export interface ScanEvent {
  gatewayId: string;
  tagId: string;
  rssi: number; // dBm (음수, 클수록 가까움: -50 > -90)
  timestamp: number;
}

// ─── 존 액션 (설계서 6.4) ───────────────────────────────────────────────────

export type ZoneActionType = 'info' | 'reaction' | 'checkin' | 'faq';

export interface ZoneAction {
  actionId: string;
  zoneId: string;
  label: string;
  type: ZoneActionType;
}

// ─── WebSocket 프로토콜 (설계서 7) ──────────────────────────────────────────

/** namespace: /patient — 서버→클라 */
export interface PatientServerEvents {
  'presence:self': (p: { zone: string | null; waitingRank: number; estimatedWaitSec: number }) => void;
  'zone:occupancy': (p: { zoneId: string; anonymousCount: number }) => void;
  'zone:actions': (actions: ZoneAction[]) => void;
  'chat:message': (p: { alias: string; text: string; ts: number }) => void;
  reaction: (p: { alias: string; emoji: string; ts: number }) => void;
}

/** namespace: /patient — 클라→서버 */
export interface PatientClientEvents {
  'chat:send': (p: { text: string }) => void;
  'reaction:send': (p: { emoji: string }) => void;
  'action:invoke': (p: { actionId: string }) => void;
}

/** namespace: /staff — 서버→클라 */
export interface StaffServerEvents {
  'presence:update': (states: PresenceState[]) => void; // 권한 필터링된 대상만
  'presence:remove': (p: { tagId: string }) => void;
  'waittime:update': (p: { personId: string; zone: string; durationSec: number }) => void;
}

/** namespace: /staff — 클라→서버 */
export interface StaffClientEvents {
  'person:locate': (p: { personId: string }) => void;
  'filter:set': (p: { zoneId?: string; dept?: string }) => void;
}

/** JWT payload — role·dept·담당구역 claim (설계서 4) */
export interface AuthClaims {
  personId: string;
  type: PersonType;
  role?: StaffRole;
  dept?: string;
  chargeZones?: string[]; // 간호사 담당구역
}
